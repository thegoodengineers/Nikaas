"""Key-value store for the platform (sites, people, alarms, hazards, sensors, cameras, events).

One DynamoDB table when NIKAAS_TABLE is set (Lambda instances share it); a dict in memory otherwise
(local runs and tests). Items are addressed by (pk, sk) and read a whole partition at once, so a
dashboard gets everything for one site in a single query.
"""
import json
import os
import threading
import time

_lock = threading.Lock()


class MemoryStore:
    def __init__(self):
        self.items: dict[str, dict[str, tuple[dict, float | None]]] = {}

    def get(self, pk: str, sk: str) -> dict | None:
        with _lock:
            v = self.items.get(pk, {}).get(sk)
        if not v or (v[1] is not None and v[1] < time.time()):
            return None
        return json.loads(json.dumps(v[0]))

    def put(self, pk: str, sk: str, data: dict, ttl_s: float | None = None) -> None:
        exp = time.time() + ttl_s if ttl_s else None
        with _lock:
            self.items.setdefault(pk, {})[sk] = (json.loads(json.dumps(data)), exp)

    def delete(self, pk: str, sk: str) -> None:
        with _lock:
            self.items.get(pk, {}).pop(sk, None)

    def query(self, pk: str, prefix: str = "") -> list[tuple[str, dict]]:
        now = time.time()
        with _lock:
            rows = sorted(self.items.get(pk, {}).items())
        return [(sk, json.loads(json.dumps(d))) for sk, (d, exp) in rows if sk.startswith(prefix) and (exp is None or exp >= now)]


class DynamoStore:
    """Items are {pk, sk, data: JSON text, exp: epoch seconds}. `exp` is the table's TTL attribute; reads
    also skip expired items because DynamoDB deletes them lazily."""

    def __init__(self, table: str):
        import boto3  # on Lambda; not needed locally

        self.t = boto3.resource("dynamodb").Table(table)

    def get(self, pk, sk):
        it = self.t.get_item(Key={"pk": pk, "sk": sk}, ConsistentRead=True).get("Item")
        if not it or ("exp" in it and int(it["exp"]) < time.time()):
            return None
        return json.loads(it["data"])

    def put(self, pk, sk, data, ttl_s=None):
        item = {"pk": pk, "sk": sk, "data": json.dumps(data)}
        if ttl_s:
            item["exp"] = int(time.time() + ttl_s)
        self.t.put_item(Item=item)

    def delete(self, pk, sk):
        self.t.delete_item(Key={"pk": pk, "sk": sk})

    def query(self, pk, prefix=""):
        from boto3.dynamodb.conditions import Key

        cond = Key("pk").eq(pk) & Key("sk").begins_with(prefix) if prefix else Key("pk").eq(pk)
        out, kw, now = [], {"KeyConditionExpression": cond, "ConsistentRead": True}, time.time()
        while True:
            r = self.t.query(**kw)
            out += [(it["sk"], json.loads(it["data"])) for it in r["Items"] if "exp" not in it or int(it["exp"]) >= now]
            if "LastEvaluatedKey" not in r:
                return out
            kw["ExclusiveStartKey"] = r["LastEvaluatedKey"]


_store = None


def store():
    global _store
    if _store is None:
        table = os.environ.get("NIKAAS_TABLE")
        _store = DynamoStore(table) if table else MemoryStore()
    return _store


def reset_memory():
    """Tests: start from an empty in-memory store."""
    global _store
    _store = MemoryStore()
    return _store
