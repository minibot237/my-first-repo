#!/usr/bin/env python3
"""Fetch unseen emails via IMAP and save as .eml files.

Usage: imap-fetch.py <server> <port> <username> <output_dir>
Password is read from IMAP_PASSWORD environment variable.

Prints JSON: {"fetched": N, "errors": []} or {"error": "..."}
"""
import imaplib
import email
import json
import os
import sys
from datetime import datetime

def main():
    if len(sys.argv) != 5:
        print(json.dumps({"error": "usage: imap-fetch.py <server> <port> <username> <output_dir>"}))
        sys.exit(1)

    server, port, username, output_dir = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4]
    password = os.environ.get("IMAP_PASSWORD", "")
    if not password:
        print(json.dumps({"error": "IMAP_PASSWORD not set"}))
        sys.exit(1)

    os.makedirs(output_dir, exist_ok=True)

    try:
        mail = imaplib.IMAP4_SSL(server, port)
        mail.login(username, password)
    except Exception as e:
        print(json.dumps({"error": f"login failed: {e}"}))
        sys.exit(1)

    try:
        mail.select("INBOX")
        status, data = mail.search(None, "UNSEEN")
        if status != "OK":
            print(json.dumps({"error": f"search failed: {status}"}))
            sys.exit(1)

        msg_ids = data[0].split()
        fetched = 0
        errors = []

        for msg_id in msg_ids:
            try:
                status, msg_data = mail.fetch(msg_id, "(RFC822)")
                if status != "OK":
                    errors.append(f"fetch {msg_id}: {status}")
                    continue

                raw = msg_data[0][1]
                ts = datetime.now().strftime("%Y%m%d-%H%M%S")
                filename = f"{ts}-{msg_id.decode()}.eml"
                filepath = os.path.join(output_dir, filename)

                with open(filepath, "wb") as f:
                    f.write(raw)

                fetched += 1
            except Exception as e:
                errors.append(f"fetch {msg_id}: {e}")

        mail.close()
        mail.logout()

        print(json.dumps({"fetched": fetched, "errors": errors}))
    except Exception as e:
        try:
            mail.logout()
        except:
            pass
        print(json.dumps({"error": f"imap error: {e}"}))
        sys.exit(1)

if __name__ == "__main__":
    main()
