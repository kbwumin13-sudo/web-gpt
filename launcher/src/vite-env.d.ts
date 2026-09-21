declare module "*.css" {
  const href: string;
  export default href;
}

/** Resolved by `resolve.alias` to whichever renderer entry this build contains. */
declare module "#launcher-frontend" {
  export const App: () => JSX.Element;
}

/** Replaced at build time by `define`; `true` only in a Web GPT build. */
declare const __WEB_GPT_FRONTEND__: boolean;
