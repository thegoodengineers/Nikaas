"""SMS: emergency texts and phone-number verification.

Providers (NIKAAS_SMS): "sns" (Amazon SNS, the default on AWS), "fast2sms" (FAST2SMS_API_KEY, Indian Quick SMS route),
"twilio" (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM), or "log" (local runs and tests: messages go to OUTBOX).

Amazon SNS starts every account in the SMS sandbox: it only texts numbers verified with a one-time code, at most 10,
under a USD 1 monthly spend limit, until AWS Support moves the account to production. Registration uses that
verification directly (SNS sends the code), so a demo works without extra setup. Texts to India go over the
international route with a numeric sender, which needs no DLT registration; a branded sender ID needs DLT.
"""
import base64
import hashlib
import json
import os
import re
import secrets
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

OUTBOX: list[dict] = []  # "log" provider
_sandbox_cache: tuple[float, bool | None] = (0.0, None)


class SmsError(Exception):
    """A problem the person can act on (shown to them)."""


def provider() -> str:
    p = os.environ.get("NIKAAS_SMS")
    if p:
        return p
    return "sns" if os.environ.get("AWS_LAMBDA_FUNCTION_NAME") else "log"


def normalize(phone: str, default_cc: str = "91") -> str:
    """+E.164 from what people type: '98765 43210', '098765-43210', '+91 98765 43210', '0091...'."""
    s = re.sub(r"[\s\-().]", "", str(phone or ""))
    if s.startswith("00"):
        s = "+" + s[2:]
    if s.startswith("+"):
        digits = s[1:]
    elif len(s) == 10 and s[0] in "6789" and default_cc == "91":
        digits = "91" + s
    elif len(s) == 11 and s.startswith("0"):
        digits = default_cc + s[1:]
    else:
        digits = default_cc + s if len(s) <= 10 else s
    if not digits.isdigit() or not 8 <= len(digits) <= 15:
        raise SmsError("Enter a mobile number, for example 98765 43210")
    if digits.startswith("91") and not re.fullmatch(r"91[6-9]\d{9}", digits):
        raise SmsError("An Indian mobile number has 10 digits and starts with 6, 7, 8 or 9")
    return "+" + digits


def mask(e164: str | None) -> str | None:
    if not e164:
        return None
    return f"{e164[:-10]} {e164[-10:-8]}{'•' * 5}{e164[-3:]}" if len(e164) >= 12 else e164[:3] + "•" * (len(e164) - 6) + e164[-3:]


def _sns():
    import boto3

    return boto3.client("sns")


def sandbox() -> bool | None:
    """True while the SNS account is in the SMS sandbox (cached for 5 minutes). None for other providers."""
    global _sandbox_cache
    if provider() != "sns":
        return None
    if time.time() - _sandbox_cache[0] < 300 and _sandbox_cache[1] is not None:
        return _sandbox_cache[1]
    try:
        v = bool(_sns().get_sms_sandbox_account_status()["IsInSandbox"])
    except Exception:
        v = True  # cannot tell: assume the stricter case
    _sandbox_cache = (time.time(), v)
    return v


def sandbox_numbers() -> dict[str, str]:
    """Numbers on the SNS sandbox list -> 'Verified' or 'Pending'."""
    try:
        out, kw = {}, {}
        while True:
            r = _sns().list_sms_sandbox_phone_numbers(**kw)
            out.update({p["PhoneNumber"]: p["Status"] for p in r.get("PhoneNumbers", [])})
            if not r.get("NextToken"):
                return out
            kw["NextToken"] = r["NextToken"]
    except Exception:
        return {}


def send(phone: str, text: str) -> dict:
    """Send one text. Returns {ok, id} or {ok: False, error}. Never raises."""
    p = provider()
    try:
        if p == "log":
            OUTBOX.append({"to": phone, "text": text, "at": time.time()})
            print(f"[sms] to {mask(phone)}: {text}", flush=True)  # local runs: read codes and links from the server log
            return {"ok": True, "id": f"log-{len(OUTBOX)}"}
        if p == "sns":
            r = _sns().publish(PhoneNumber=phone, Message=text, MessageAttributes={
                "AWS.SNS.SMS.SMSType": {"DataType": "String", "StringValue": "Transactional"}})
            return {"ok": True, "id": r.get("MessageId")}
        if p == "fast2sms":
            body = json.dumps({"route": "q", "message": text, "flash": 0, "numbers": phone.removeprefix("+91")}).encode()
            req = urllib.request.Request("https://www.fast2sms.com/dev/bulkV2", data=body, method="POST",
                                         headers={"authorization": os.environ["FAST2SMS_API_KEY"], "content-type": "application/json"})
            with urllib.request.urlopen(req, timeout=10) as r:
                j = json.loads(r.read())
            return {"ok": bool(j.get("return")), "id": j.get("request_id"), "error": None if j.get("return") else str(j.get("message"))}
        if p == "twilio":
            sid = os.environ["TWILIO_ACCOUNT_SID"]
            data = urllib.parse.urlencode({"To": phone, "From": os.environ["TWILIO_FROM"], "Body": text}).encode()
            auth = base64.b64encode(f"{sid}:{os.environ['TWILIO_AUTH_TOKEN']}".encode()).decode()
            req = urllib.request.Request(f"https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json", data=data, method="POST",
                                         headers={"Authorization": f"Basic {auth}"})
            with urllib.request.urlopen(req, timeout=10) as r:
                return {"ok": True, "id": json.loads(r.read()).get("sid")}
        return {"ok": False, "error": f"SMS provider '{p}' is off"}
    except urllib.error.HTTPError as e:
        return {"ok": False, "error": f"HTTP {e.code}"}
    except Exception as e:  # network, credentials, sandbox: report, never crash an alarm
        return {"ok": False, "error": type(e).__name__ + (f": {e}" if str(e) else "")[:200]}


def send_many(items: list[tuple[str, str]]) -> list[dict]:
    if not items:
        return []
    with ThreadPoolExecutor(max_workers=min(10, len(items))) as pool:
        return list(pool.map(lambda it: send(*it), items))


# ---------- verification ----------
def code_hash(token: str, code: str) -> str:
    return hashlib.sha256(f"{token}:{code}".encode()).hexdigest()


def start_verify(phone: str, token: str, site_name: str) -> dict:
    """Send a one-time code to `phone`. Returns {method, hash?}: method "sandbox" (SNS sends its own code),
    "code" (we sent ours; keep `hash`), or "none" (already verified with SNS)."""
    if provider() == "sns" and sandbox():
        status = sandbox_numbers().get(phone)
        if status == "Verified":
            return {"method": "none"}
        try:
            _sns().create_sms_sandbox_phone_number(PhoneNumber=phone, LanguageCode="en-US")
        except Exception as e:
            name = type(e).__name__
            if "OptedOut" in name or "OptedOut" in str(e):
                raise SmsError("This number has opted out of SMS. Reply START to the sender to opt back in.")
            if "Limit" in name or "limit" in str(e).lower():
                raise SmsError("The SMS test setup is full (10 numbers). Ask the organiser to free a slot.")
            if "InvalidParameter" in name:
                raise SmsError("That number could not be used for SMS. Check it and try again.")
            if "Throttl" in name:
                raise SmsError("Too many codes sent just now. Wait a minute and try again.")
            raise SmsError("Could not send the code right now. Try again in a minute.")
        return {"method": "sandbox"}
    code = f"{secrets.randbelow(1_000_000):06d}"
    r = send(phone, f"Nikaas code {code} for emergency alerts at {site_name[:40]}. It expires in 10 minutes.")
    if not r["ok"]:
        raise SmsError("Could not send the code right now. Try again in a minute.")
    return {"method": "code", "hash": code_hash(token, code)}


def finish_verify(phone: str, token: str, code: str, method: str, expected_hash: str | None) -> bool:
    code = re.sub(r"\D", "", code or "")
    if len(code) < 4:
        return False
    if method == "sandbox":
        try:
            _sns().verify_sms_sandbox_phone_number(PhoneNumber=phone, OneTimePassword=code)
            return True
        except Exception:
            return False
    return bool(expected_hash) and secrets.compare_digest(code_hash(token, code), expected_hash)


def last_code(phone: str) -> str | None:
    """Tests and local runs: the newest code texted to `phone` by the log provider."""
    for m in reversed(OUTBOX):
        if m["to"] == phone:
            g = re.search(r"code (\d{6})", m["text"])
            if g:
                return g.group(1)
    return None
