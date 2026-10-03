// Preloaded into a child process with `node -r` to give it a fixed clock: FAKE_NOW is an ISO time.
// Tests use it so that a hook or command run as a real process sees the same "today" as the simulated
// transcripts, whatever the date of the machine. Without FAKE_NOW it does nothing.
const fixed = Date.parse(process.env.FAKE_NOW || "");
if (Number.isFinite(fixed)) {
  const Real = Date;
  class FakeDate extends Real {
    constructor(...args) {
      if (args.length === 0) super(fixed);
      else super(...args);
    }

    static now() {
      return fixed;
    }
  }
  globalThis.Date = FakeDate;
}
