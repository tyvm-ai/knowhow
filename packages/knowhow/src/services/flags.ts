export class FlagsService {
  flags = {};
  log = false;

  constructor(flags: string[] = [], log = false) {
    this.register(flags);
    this.log = log;
  }

  register(flags: string[]) {
    flags.forEach((flag) => {
      this.flags[flag] = false;
    });
  }

  enable(flag: string) {
    this.flags[flag] = true;
    if (this.log) {
      console.log(`${flag} is now enabled \n`);
    }
  }

  disable(flag: string) {
    this.flags[flag] = false;
    if (this.log) {
      console.log(`${flag} is now disabled \n`);
    }
  }

  flip(flag: string) {
    this.flags[flag] = !this.flags[flag];
    if (this.log) {
      const status = this.flags[flag] ? "enabled" : "disabled";
      const message = `${flag} is now ${status}`;
      console.log(message);
    }
  }

  enableLogging() {
    this.log = true;
  }

  disableLogging() {
    this.log = false;
  }

  enabled(flag: string): boolean {
    return this.flags[flag];
  }
}

