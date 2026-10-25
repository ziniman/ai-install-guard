"""Which changed files may be sent for review: never a key file."""

_KEY_FILES = frozenset(('id_rsa', 'id_ed25519', '.netrc', '.npmrc'))


def reviewable(diff):
    return [line for line in diff.splitlines() if line.rsplit("/", 1)[-1] not in _KEY_FILES]
