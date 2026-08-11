declare module "tau-prolog" {
  const prolog: any;
  export = prolog;
}

declare module "tau-prolog/modules/lists" {
  const install: (prolog: any) => void;
  export = install;
}
