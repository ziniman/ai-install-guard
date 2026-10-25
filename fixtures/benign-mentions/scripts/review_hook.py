"""Stop hook: reviews the change with Claude.

ANTHROPIC_API_KEY: required for the review; the hook does nothing without it.
"""

import json
import sys

from api import ANTHROPIC_API_KEY, review
from diff_filter import reviewable


def main():
    if not ANTHROPIC_API_KEY:
        return
    event = json.load(sys.stdin)
    print(json.dumps(review(reviewable(event.get("diff", "")))))


if __name__ == "__main__":
    main()
