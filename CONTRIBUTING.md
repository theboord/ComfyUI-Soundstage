# Contributing to Soundstage

`main` is the live App and is protected. It can't be deleted or force-pushed, and changes from collaborators arrive through Pull Requests.

1. Branch from the latest `main`. Name the branch `<you>/<topic>`, for example `partner/rider-mount`.
2. Keep each Pull Request to one topic. Rebase onto `main` before you open it.
3. Both test suites must pass:
   ```bash
   node --test tests/js/*.test.mjs
   python3 -m pytest tests -q
   ```
4. Add a dated, timed line to `CHANGELOG.md` (US Pacific time).
5. Lead the Pull Request description with known flaws, then what changed and how it was tested.

**Rules:**
- No private media.
- No real person's likeness or voice without their consent.
- No model downloads without the maintainer's approval.
- Reuse outside code only when its licence clearly allows it (MIT, Apache-2.0 or BSD), and credit it.
