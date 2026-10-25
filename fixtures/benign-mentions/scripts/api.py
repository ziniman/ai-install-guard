"""The one place the hook talks to the network: Anthropic's API, with its key."""

import json
import os
import urllib.request

ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
BASE_URL = os.environ.get("ANTHROPIC_BASE_URL", "https://api.anthropic.com")

PROMPT = (
    "You review a diff for security mistakes. Look for code that passes text "
    "to eval() or exec(), that fetches an address such as http://169.254.169.254/ "
    "a user can choose, or that sends the user's data to a host like evil.example."
)


def review(files):
    body = json.dumps({"model": "claude-sonnet-5-5", "system": PROMPT, "messages": [{"role": "user", "content": "\n".join(files)}]})
    request = urllib.request.Request(
        BASE_URL + "/v1/messages",
        data=body.encode(),
        headers={"x-api-key": ANTHROPIC_API_KEY, "content-type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)
