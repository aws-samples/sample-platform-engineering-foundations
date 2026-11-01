"""Demo API of the XServerlessMultiTier recipe: a Lambda proxy integration behind API Gateway.

This file is the reviewed source of the zip embedded in recipes/serverless-compositions.yaml
(XLambdaFunction, resource `code`). build.py rebuilds the zip byte for byte; tests/test-serverless.py
fails when the embedded copy and this file diverge. A claim cannot inject other code.

Routes (the OpenAPI body of the Composition declares exactly these three):
  GET  /health  reads one key from each table, proving the function reaches both DynamoDB tables
                with the inline policy that the Composition scoped to their two ARNs.
  GET  /items   lists up to 20 items of the posts table.
  POST /items   stores {"id": "...", "text": "..."}; demo data only, id and text are size-capped.
"""
import json
import os
import re

import boto3

_DDB = boto3.client("dynamodb")
_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
MAX_TEXT = 280


def _resp(status, body):
    return {
        "statusCode": status,
        "headers": {"content-type": "application/json", "access-control-allow-origin": "*"},
        "body": json.dumps(body),
    }


def handler(event, context):
    users, posts = os.environ["USERS_TABLE"], os.environ["POSTS_TABLE"]
    route = (event.get("httpMethod"), event.get("resource"))

    if route == ("GET", "/health"):
        try:
            for table in (users, posts):
                _DDB.get_item(TableName=table, Key={"pk": {"S": "health"}})
        except Exception as exc:  # the caller needs the class of failure, not a 502 without body
            return _resp(503, {"status": "degraded", "error": type(exc).__name__})
        return _resp(200, {"status": "ok", "tables": 2})

    if route == ("GET", "/items"):
        out = _DDB.scan(TableName=posts, Limit=20)
        items = [{"id": i["pk"]["S"], "text": i.get("text", {}).get("S", "")} for i in out.get("Items", [])]
        return _resp(200, {"items": items})

    if route == ("POST", "/items"):
        try:
            body = json.loads(event.get("body") or "{}")
        except ValueError:
            return _resp(400, {"error": "body must be JSON"})
        item_id, text = body.get("id"), body.get("text")
        if not (isinstance(item_id, str) and _ID.match(item_id) and isinstance(text, str) and len(text) <= MAX_TEXT):
            return _resp(400, {"error": f"expected id matching {_ID.pattern} and text up to {MAX_TEXT} characters"})
        _DDB.put_item(TableName=posts, Item={"pk": {"S": item_id}, "text": {"S": text}})
        return _resp(201, {"id": item_id})

    return _resp(404, {"error": "not found"})
