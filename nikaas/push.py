"""Web Push: alerts that reach a phone even when the page is closed.

Implements message encryption (RFC 8291, aes128gcm from RFC 8188) and VAPID sender identification
(RFC 8292) on `cryptography`, and posts to the browser's push service with urllib. The VAPID key pair is
made once and kept in the store, so every Lambda instance signs with the same key.
"""
import base64
import hashlib
import hmac
import json
import os
import struct
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlparse

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from .store import store

CONTACT = os.environ.get("NIKAAS_PUSH_CONTACT", "https://github.com/thegoodengineers/Nikaas")


def b64u(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def unb64u(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _raw_public(key) -> bytes:
    return key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)


def vapid_keys():
    """(private key, public key as base64url). Made on first use and stored."""
    rec = store().get("CONFIG", "VAPID")
    if rec is None:
        k = ec.generate_private_key(ec.SECP256R1())
        pem = k.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()).decode()
        rec = {"private_pem": pem, "public": b64u(_raw_public(k))}
        store().put("CONFIG", "VAPID", rec)
    key = serialization.load_pem_private_key(rec["private_pem"].encode(), None)
    return key, rec["public"]


def _hkdf_extract(salt: bytes, ikm: bytes) -> bytes:
    return hmac.new(salt, ikm, hashlib.sha256).digest()


def _hkdf_expand(prk: bytes, info: bytes, n: int) -> bytes:
    return hmac.new(prk, info + b"\x01", hashlib.sha256).digest()[:n]  # n <= 32: one block is enough


def encrypt(payload: bytes, p256dh: str, auth: str, *, sender_key=None, salt: bytes | None = None) -> bytes:
    """aes128gcm body for one subscription (RFC 8291 section 3.4)."""
    ua_public = unb64u(p256dh)
    auth_secret = unb64u(auth)
    as_key = sender_key or ec.generate_private_key(ec.SECP256R1())
    as_public = _raw_public(as_key)
    shared = as_key.exchange(ec.ECDH(), ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), ua_public))
    prk_key = _hkdf_extract(auth_secret, shared)
    ikm = _hkdf_expand(prk_key, b"WebPush: info\x00" + ua_public + as_public, 32)
    salt = salt or os.urandom(16)
    prk = _hkdf_extract(salt, ikm)
    cek = _hkdf_expand(prk, b"Content-Encoding: aes128gcm\x00", 16)
    nonce = _hkdf_expand(prk, b"Content-Encoding: nonce\x00", 12)
    record = AESGCM(cek).encrypt(nonce, payload + b"\x02", None)  # 0x02: last (and only) record
    return salt + struct.pack("!IB", 4096, len(as_public)) + as_public + record


def vapid_header(endpoint: str) -> str:
    key, public = vapid_keys()
    u = urlparse(endpoint)
    header = b64u(json.dumps({"typ": "JWT", "alg": "ES256"}).encode())
    claims = b64u(json.dumps({"aud": f"{u.scheme}://{u.netloc}", "exp": int(time.time()) + 12 * 3600, "sub": CONTACT}).encode())
    signing = f"{header}.{claims}".encode()
    r, s = decode_dss_signature(key.sign(signing, ec.ECDSA(hashes.SHA256())))
    sig = r.to_bytes(32, "big") + s.to_bytes(32, "big")
    return f"vapid t={header}.{claims}.{b64u(sig)}, k={public}"


def send(sub: dict, message: dict, ttl: int = 600) -> int:
    """Send one push. Returns the push service's HTTP status (201 = queued; 404/410 = subscription gone)."""
    body = encrypt(json.dumps(message).encode(), sub["keys"]["p256dh"], sub["keys"]["auth"])
    req = urllib.request.Request(sub["endpoint"], data=body, method="POST", headers={
        "TTL": str(ttl), "Urgency": "high", "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream",
        "Authorization": vapid_header(sub["endpoint"]),
    })
    try:
        with urllib.request.urlopen(req, timeout=6) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code
    except (urllib.error.URLError, TimeoutError, OSError):
        return 0


def send_many(items: list[tuple[str, dict]], message_for) -> dict[str, int]:
    """Send to many phones in parallel: items are (token, subscription); message_for(token) -> message."""
    if not items:
        return {}
    with ThreadPoolExecutor(max_workers=min(16, len(items))) as pool:
        codes = list(pool.map(lambda it: send(it[1], message_for(it[0])), items))
    return {tok: c for (tok, _), c in zip(items, codes)}
