#!/usr/bin/env python3
"""Send an email via SMTP.

Usage: smtp-send.py <server> <port> <username> <from> <to> <subject>
Body is read from stdin. Password from SMTP_PASSWORD env var.

Prints JSON: {"ok": true, "message": "sent"} or {"error": "..."}
"""
import smtplib
import json
import os
import sys
from email.mime.text import MIMEText

def main():
    if len(sys.argv) != 7:
        print(json.dumps({"error": "usage: smtp-send.py <server> <port> <username> <from> <to> <subject>"}))
        sys.exit(1)

    server, port, username, from_addr, to_addr, subject = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4], sys.argv[5], sys.argv[6]
    password = os.environ.get("SMTP_PASSWORD", "")
    if not password:
        print(json.dumps({"error": "SMTP_PASSWORD not set"}))
        sys.exit(1)

    body = sys.stdin.read()

    msg = MIMEText(body, "plain", "utf-8")
    msg["From"] = from_addr
    msg["To"] = to_addr
    msg["Subject"] = subject

    try:
        if port == 465:
            smtp = smtplib.SMTP_SSL(server, port, timeout=15)
        else:
            smtp = smtplib.SMTP(server, port, timeout=15)
            smtp.starttls()

        smtp.login(username, password)
        smtp.sendmail(from_addr, [to_addr], msg.as_string())
        smtp.quit()
        print(json.dumps({"ok": True, "message": "sent"}))
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}))
        sys.exit(1)

if __name__ == "__main__":
    main()
