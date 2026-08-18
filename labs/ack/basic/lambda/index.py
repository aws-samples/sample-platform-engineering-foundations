import json
import os
import logging

logger = logging.getLogger()
logger.setLevel(logging.INFO)

DB_HOST = os.environ.get("DB_HOST", "localhost")
DB_NAME = os.environ.get("DB_NAME", "appdb")
DB_PORT = os.environ.get("DB_PORT", "5432")


def handler(event, context):
    logger.info("Event: %s", json.dumps(event))

    http = event.get("requestContext", {}).get("http", {})
    method = http.get("method", "GET")
    path = http.get("path", "/")

    if path == "/health":
        return _response(200, {"status": "healthy"})

    if path == "/config":
        return _response(200, {
            "db_host": DB_HOST,
            "db_name": DB_NAME,
            "db_port": DB_PORT,
        })

    return _response(200, {
        "message": "Hello from ACK serverless app",
        "method": method,
        "path": path,
    })


def _response(status_code, body):
    return {
        "statusCode": status_code,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(body),
    }
