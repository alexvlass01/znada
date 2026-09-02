'use strict';

// DELIBERATELY BROKEN. Not part of the app, and excluded from the ordinary lint run.
//
// A gate nobody has watched fail is not a gate: a misconfigured linter that reports
// nothing looks exactly like a clean codebase. test/static-gates.test.js runs the real
// linter over this file and requires it to complain.
//
// The defect is the one this project has actually shipped before: a call to a function
// that does not exist. It parses perfectly, `node --check` passes it, and it throws at
// runtime - which is how thumbnail aspect prefetch was once silently killed.

function callsSomethingThatIsNotThere() {
  return isTrustedThumbnailSender({ sender: null });
}

module.exports = { callsSomethingThatIsNotThere };
