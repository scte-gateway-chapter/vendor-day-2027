# Pre-Launch Follow-up Task Template

Use this template to open a follow-up task for any item that fails
during the `docs/pre-launch-checklist.md` walkthrough. Copy one block
per failure into `.kiro/specs/vendor-day-app/tasks.md` under a new
heading `## Pre-launch follow-ups` at the end of the file, or create a
GitHub issue with the same structure.

Do not close out the pre-launch checklist until every failure here has
either been resolved or has an acknowledged workaround signed off by
both Section 7 admins.

---

- [ ] **F<N>. <Short title that matches the failed checklist item>**
  - Checklist section and item: Section <X> item <Y>
  - Observed: <what actually happened, with error text or screenshot
    path>
  - Expected: <what the checklist item said should happen>
  - Device / environment: <browser, OS, device, network>
  - Suspected cause: <best guess, link to the deployment or admin
    runbook section that covers the fix>
  - Owner: <who is driving this to resolution>
  - Target resolution date: <YYYY-MM-DD, must be before the event>
  - Resolution: <filled in when the item is fixed; cite the commit
    or env-var change that resolved it>
  - _Requirements:_ <copy the requirement refs from the failed
    checklist item>

---

Example (filled in):

- [ ] **F1. iOS 16.4 push did not deliver on first test iPhone**
  - Checklist section and item: Section 2 item 2
  - Observed: Published announcement with push on from admin; iPhone
    (iOS 17.2, Safari-installed PWA) did not receive a notification
    within 60 seconds. OneSignal dashboard shows one delivered
    subscriber but zero clicks.
  - Expected: Notification arrives within 10 seconds; tap opens the
    announcement card.
  - Device / environment: iPhone 13, iOS 17.2, installed PWA, home
    Wi-Fi.
  - Suspected cause: Service worker arrangement regression — see
    `docs/deployment.md` → Service worker arrangement. Confirm
    `public/sw.js` still has the OneSignal `importScripts` as the
    first executable line.
  - Owner: Board member A
  - Target resolution date: 2027-05-10
  - Resolution: _(pending)_
  - _Requirements:_ 2.2, 2.3, 6.2, 6.3
