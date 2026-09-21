import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { copyFor, localizeRuntimeMessage, type Copy } from "./i18n";
import { BrandMark, Icon, type IconName } from "./icons";
import "./styles.css";
import type {
  BrowserInteractionMode,
  BrowserState,
  DoctorReport,
  Language,
  LauncherSnapshot,
  LauncherState,
  LogRecord,
  OperationState,
  Surface,
} from "../types";

const api = window.codexWebLauncher;
const DEVELOPER_URL = "https://github.com/kbwumin13-sudo?tab=repositories";
const COMPACT_QUERY = "(max-width: 820px)";

export function App() {
  const [snapshot, setSnapshot] = useState<LauncherSnapshot | null>(null);
  const [browser, setBrowser] = useState<BrowserState | null>(null);
  const [operation, setOperation] = useState<OperationState | null>(null);
  const [logs, setLogs] = useState<LogRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const language = snapshot?.state.language ?? "en";
  const copy = copyFor(language);

  const updateState = useCallback((state: LauncherState) => {
    setSnapshot((current) => current ? { ...current, state } : current);
  }, []);

  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    void api.snapshot().then((next) => {
      if (cancelled) return;
      setSnapshot(next);
      setBrowser(next.browser);
      setOperation(next.operation);
      setLogs(next.logs);
      if (next.operation?.status === "failed" && next.operation.name !== "mcp-verification") setError(next.operation.message);
    }).catch((cause) => setError(messageOf(cause)));
    const offState = api.onStateChanged(updateState);
    const offBrowser = api.onBrowserState(setBrowser);
    const offOperation = api.onOperation((next) => {
      setOperation(next);
      if (next.status === "failed" && next.name !== "mcp-verification") setError(next.message);
    });
    const offLog = api.onLog((record) => setLogs((current) => [...current.slice(-299), record]));
    return () => {
      cancelled = true;
      offState();
      offBrowser();
      offOperation();
      offLog();
    };
  }, [updateState]);

  if (!api) return <div className="wg-fatal">Launcher IPC is unavailable.</div>;
  if (!snapshot) return <div className="wg-loading"><BrandMark /> <span>Loading Web GPT…</span></div>;

  return (
    <div className="wg-root" data-language={language} data-platform={snapshot.platform} data-profile={snapshot.profile} data-theme="dark">
      {snapshot.state.onboardingComplete ? (
        <Shell
          browser={browser}
          copy={copy}
          logs={logs}
          operation={operation}
          setError={setError}
          snapshot={snapshot}
          updateState={updateState}
        />
      ) : (
        <Onboarding copy={copy} setError={setError} snapshot={snapshot} updateState={updateState} />
      )}
      {error ? <ErrorToast copy={copy} message={error} onDismiss={() => setError(null)} /> : null}
    </div>
  );
}

function Onboarding({ copy, setError, snapshot, updateState }: {
  copy: Copy;
  setError: (message: string | null) => void;
  snapshot: LauncherSnapshot;
  updateState: (state: LauncherState) => void;
}) {
  const [stage, setStage] = useState<0 | 1>(snapshot.state.language ? 1 : 0);
  const [selectedLanguage, setSelectedLanguage] = useState<Language>(snapshot.state.language ?? "en");
  const [selectedMode, setSelectedMode] = useState<BrowserInteractionMode>(snapshot.state.browserInteractionMode);
  const [busy, setBusy] = useState(false);
  const localized = copyFor(selectedLanguage);
  const chooseLanguage = async () => {
    setBusy(true);
    try {
      updateState(await api!.setLanguage(selectedLanguage));
      setStage(1);
    } catch (cause) { setError(messageOf(cause)); } finally { setBusy(false); }
  };
  const finish = async () => {
    setBusy(true);
    try {
      updateState(await api!.completeOnboarding(selectedLanguage, selectedMode));
    } catch (cause) { setError(messageOf(cause)); } finally { setBusy(false); }
  };
  return (
    <main className="wg-welcome">
      <header className="wg-welcome-top draggable">
        <div className="wg-welcome-brand no-drag"><BrandMark small /><span>{localized.product}</span>{snapshot.profile === "development" ? <em className="wg-dev-badge">DEV</em> : null}</div>
        <span className="wg-welcome-version no-drag">v{snapshot.version}</span>
      </header>
      <section className="wg-welcome-stage">
        <div className="wg-welcome-mark"><BrandMark /></div>
        <span className="wg-welcome-step">0{stage + 1} / 02</span>
        <h1>{stage === 0 ? localized.chooseLanguage : localized.interactionMode}</h1>
        <p>{stage === 0 ? localized.chooseLanguageHint : localized.interactionModeBody}</p>
        {stage === 0 ? (
          <div className="wg-welcome-options" role="radiogroup" aria-label={localized.chooseLanguage}>
            <WelcomeOption active={selectedLanguage === "en"} marker="EN" label={localized.english} detail="English" onClick={() => setSelectedLanguage("en")} />
            <WelcomeOption active={selectedLanguage === "zh-CN"} marker="简" label={localized.chinese} detail="Simplified Chinese" onClick={() => setSelectedLanguage("zh-CN")} />
            <WelcomeOption active={selectedLanguage === "ja"} marker="日" label={localized.japanese} detail="日本語" onClick={() => setSelectedLanguage("ja")} />
          </div>
        ) : (
          <InteractionPicker copy={localized} disabled={busy} mode={selectedMode} onChange={setSelectedMode} />
        )}
      </section>
      <footer className="wg-welcome-footer">
        <div>{stage > 0 ? <button className="wg-text-button" disabled={busy} onClick={() => setStage((stage - 1) as 0 | 1)} type="button">{localized.previous}</button> : null}</div>
        <div className="wg-progress" aria-label={`${stage + 1} / 2`}>{[0, 1].map((index) => <span className={index < stage ? "is-complete" : index === stage ? "is-active" : ""} key={index} />)}</div>
        <button className="wg-primary" disabled={busy} onClick={() => stage === 0 ? void chooseLanguage() : void finish()} type="button">{stage === 1 ? localized.finishWelcome : localized.continue}</button>
      </footer>
    </main>
  );
}

function Shell({ browser, copy, logs, operation, setError, snapshot, updateState }: {
  browser: BrowserState | null;
  copy: Copy;
  logs: LogRecord[];
  operation: OperationState | null;
  setError: (message: string | null) => void;
  snapshot: LauncherSnapshot;
  updateState: (state: LauncherState) => void;
}) {
  const initialSurface: Surface = snapshot.state.coreSetupComplete ? "overview" : "setup";
  const [surface, setSurface] = useState<Surface>(initialSurface);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [compact, setCompact] = useState(window.matchMedia(COMPACT_QUERY).matches);
  const [browserSlot, setBrowserSlot] = useState<HTMLDivElement | null>(null);
  const [mcpTargetMode, setMcpTargetMode] = useState<BrowserInteractionMode | null>(null);
  const selectedManualTab = browser?.tabs.find((tab) => tab.active && tab.interactionMode === "manual");
  const navigate = useCallback((next: Surface) => {
    setSurface(next);
    if (compact) setSidebarOpen(false);
  }, [compact]);
  const browserActive = surface === "browser" && !(compact && sidebarOpen);

  useEffect(() => {
    const media = window.matchMedia(COMPACT_QUERY);
    const apply = () => { setCompact(media.matches); if (media.matches) setSidebarOpen(false); else setSidebarOpen(true); };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, []);

  useEffect(() => {
    if (selectedManualTab) {
      setSurface("browser");
      setSidebarOpen(false);
      void api!.setBrowserSurfaceActive(true).catch((cause) => setError(messageOf(cause)));
    }
  }, [selectedManualTab?.id, selectedManualTab?.manualState, setError]);

  useLayoutEffect(() => {
    let frame = 0;
    let observer: ResizeObserver | null = null;
    const measure = () => {
      if (!browserSlot) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rect = browserSlot.getBoundingClientRect();
        void api!.setBrowserBounds({ x: rect.x, y: rect.y, width: rect.width, height: rect.height }).catch((cause) => setError(messageOf(cause)));
      });
    };
    void api!.setBrowserSurfaceActive(browserActive).then(() => {
      if (!browserActive || !browserSlot) return;
      measure();
      observer = new ResizeObserver(measure);
      observer.observe(browserSlot);
      window.addEventListener("resize", measure);
    }).catch((cause) => setError(messageOf(cause)));
    return () => { cancelAnimationFrame(frame); observer?.disconnect(); window.removeEventListener("resize", measure); };
  }, [browserActive, browserSlot, setError]);

  const activateBrowser = useCallback(async (show = false) => {
    setSurface("browser");
    setSidebarOpen(false);
    await api!.setBrowserSurfaceActive(true);
    if (show) await api!.showBrowser();
  }, []);
  const configureMode = (mode: BrowserInteractionMode) => {
    setMcpTargetMode(mode);
    navigate("mcp");
  };
  const installUpdate = async () => {
    try { await api!.installUpdate(); } catch (cause) { setError(messageOf(cause)); }
  };
  const updateVisible = ["available", "downloading", "installing"].includes(snapshot.update.status);
  const updateBusy = snapshot.update.status === "downloading" || snapshot.update.status === "installing";
  const updateVersion = "version" in snapshot.update ? snapshot.update.version : "";
  const dev = snapshot.profile === "development";
  return (
    <main className="wg-shell">
      <header className="wg-titlebar">
        <div className="wg-titlebar-left no-drag">
          <button aria-label={sidebarOpen ? copy.hideSidebar : copy.showSidebar} className="wg-icon-button" onClick={() => setSidebarOpen((open) => !open)} title={sidebarOpen ? copy.hideSidebar : copy.showSidebar} type="button"><Icon name="sidebar" /></button>
          <span className="wg-titlebar-caption">{copy.product}</span>
        </div>
      </header>
      {compact && sidebarOpen ? <button aria-label={copy.close} className="wg-sidebar-backdrop" onClick={() => setSidebarOpen(false)} type="button" /> : null}
      <aside className={`wg-sidebar${compact ? " is-compact" : ""}${sidebarOpen ? " is-open" : ""}`} style={compact ? undefined : { flexBasis: snapshot.state.sidebarWidth, width: snapshot.state.sidebarWidth }}>
        {sidebarOpen ? <div className="wg-sidebar-content">
          <div className="wg-brand-row">
            <div className="wg-brand-identity"><BrandMark small /><strong>{copy.product}</strong>{dev ? <em className="wg-dev-badge">DEV</em> : null}</div>
          </div>
          <nav className="wg-sidebar-nav" aria-label={copy.workspace}>
            <NavGroup label={copy.workspace}>
              <NavItem active={surface === "overview"} icon="overview" label={copy.overview} onClick={() => navigate("overview")} />
              <NavItem active={surface === "browser"} icon="browser" label={copy.browser} onClick={() => navigate("browser")} badge={browser?.status === "error" ? "error" : undefined} />
            </NavGroup>
            <NavGroup label={copy.configuration}>
              <NavItem active={surface === "setup"} icon="setup" label={copy.setup} onClick={() => navigate("setup")} badge={!snapshot.state.coreSetupComplete ? "required" : undefined} />
              <NavItem active={surface === "mcp"} icon="mcp" label={copy.mcp} onClick={() => { setMcpTargetMode(null); navigate("mcp"); }} badge={snapshot.state.mcpSetupComplete ? undefined : "required"} />
            </NavGroup>
            <NavGroup label={copy.runtime}><NavItem active={surface === "activity"} icon="activity" label={copy.activity} onClick={() => navigate("activity")} /></NavGroup>
          </nav>
          <div className="wg-nav-footer">
            {updateVisible ? <NavItem active={false} icon="update" label={updateBusy ? copy.updating : `${copy.updateAvailable} v${updateVersion}`} onClick={() => void installUpdate()} disabled={updateBusy || operation?.status === "running"} /> : null}
            <NavItem active={surface === "settings"} icon="settings" label={copy.settings} onClick={() => navigate("settings")} />
          </div>
        </div> : null}
      </aside>
      <section className="wg-workspace">
        {surface === "overview" ? <OverviewSurface browser={browser} copy={copy} operation={operation} openActivity={() => navigate("activity")} openSetup={() => navigate("setup")} snapshot={snapshot} /> : null}
        {surface === "browser" ? <BrowserSurface browser={browser} browserSlotRef={setBrowserSlot} copy={copy} interactionMode={snapshot.state.browserInteractionMode} operation={operation} platform={snapshot.platform} setError={setError} /> : null}
        {surface === "setup" ? <SetupSurface activateBrowser={activateBrowser} browser={browser} copy={copy} devProfile={dev} setError={setError} showMcp={() => navigate("mcp")} snapshot={snapshot} updateState={updateState} /> : null}
        {surface === "mcp" ? <McpSurface copy={copy} devProfile={dev} interactionMode={mcpTargetMode ?? snapshot.state.browserInteractionMode} onDone={() => navigate("setup")} operation={operation} setError={setError} snapshot={snapshot} updateState={updateState} /> : null}
        {surface === "activity" ? <ActivitySurface copy={copy} language={snapshot.state.language ?? "en"} logs={logs} setError={setError} /> : null}
        {surface === "settings" ? <SettingsSurface configureInteractionMode={configureMode} copy={copy} devProfile={dev} language={snapshot.state.language ?? "en"} setError={setError} snapshot={snapshot} updateState={updateState} /> : null}
      </section>
    </main>
  );
}

function OverviewSurface({ browser, copy, operation, openActivity, openSetup, snapshot }: {
  browser: BrowserState | null;
  copy: Copy;
  operation: OperationState | null;
  openActivity: () => void;
  openSetup: () => void;
  snapshot: LauncherSnapshot;
}) {
  const authenticated = browser?.authenticated === true;
  const catalogReady = snapshot.state.codexCatalogVerified === true;
  const harnessReady = snapshot.state.mcpSetupComplete === true && snapshot.state.mcpRuntimeInstalled === true;
  const taskReady = authenticated && catalogReady && harnessReady;
  const next = !authenticated
    ? { title: copy.stepAccount, body: copy.stepAccountBody }
    : !catalogReady
      ? { title: copy.stepInstall, body: copy.stepInstallBody }
      : !harnessReady
        ? { title: copy.localToolsRequired, body: copy.localToolsRequiredBody }
        : { title: copy.readyForTasks, body: copy.connectionSubtitle };
  const cards: Array<{ label: string; body: string; ready: boolean }> = [
    { label: copy.accountConnection, body: authenticated ? copy.signedIn : copy.unavailable, ready: authenticated },
    { label: copy.modelCatalog, body: catalogReady ? copy.healthy : copy.unavailable, ready: catalogReady },
    { label: copy.localHarness, body: harnessReady ? copy.mcpReady : copy.unavailable, ready: harnessReady },
    { label: copy.taskRuntime, body: operation?.status === "running" ? operation.message : copy.status, ready: operation?.status !== "failed" },
  ];
  return <ContentSurface title={copy.overviewTitle} subtitle={copy.overviewSubtitle}>
    <section className={`wg-readiness${taskReady ? " is-ready" : ""}`}>
      <div><span>{taskReady ? copy.readyForTasks : copy.notReadyForTasks}</span><strong>{next.title}</strong><p>{next.body}</p></div>
      <button className="wg-primary" onClick={taskReady ? openActivity : openSetup} type="button"><Icon name={taskReady ? "activity" : "setup"} />{taskReady ? copy.openActivity : copy.openSetup}</button>
    </section>
    <div className="wg-readiness-grid">
      {cards.map(card => <article className={`wg-readiness-card${card.ready ? " is-ready" : ""}`} key={card.label}><StateDot state={card.ready ? "ready" : "idle"} /><span>{card.label}</span><strong>{card.body}</strong></article>)}
    </div>
    <SectionHeading label={copy.nextAction} spaced />
    <button className="wg-next-row" onClick={openSetup} type="button"><Icon name="setup" /><span><strong>{copy.connectionTitle}</strong><small>{copy.connectionSubtitle}</small></span><Icon name="chevron" /></button>
  </ContentSurface>;
}

function BrowserSurface({ browser, browserSlotRef, copy, interactionMode, operation, platform, setError }: {
  browser: BrowserState | null;
  browserSlotRef: (node: HTMLDivElement | null) => void;
  copy: Copy;
  interactionMode: BrowserInteractionMode;
  operation: OperationState | null;
  platform: string;
  setError: (message: string | null) => void;
}) {
  const [passkeyRequested, setPasskeyRequested] = useState(false);
  const visible = browser?.visible === true;
  const manual = interactionMode === "manual";
  const passkeyAvailable = !manual && platform === "darwin" && browser?.authenticated !== true;
  const passkeyWaiting = passkeyAvailable && operation?.name === "passkey-login" && operation.status === "running" && browser?.authenticated !== true;
  const selectedManualTab = browser?.tabs.find((tab) => tab.active && tab.interactionMode === "manual");
  const locked = browser?.status === "running" || browser?.status === "testing";
  const run = async (task: () => Promise<unknown>) => { try { await task(); } catch (cause) { setError(messageOf(cause)); } };
  const passkey = async () => {
    if (passkeyWaiting) {
      if (passkeyRequested) return;
      setPasskeyRequested(true);
      try { await api!.continuePasskeyLogin(); } catch (cause) { setPasskeyRequested(false); setError(messageOf(cause)); }
    } else {
      await run(() => api!.openPasskeyLogin());
    }
  };
  const toggle = () => run(() => visible ? api!.hideBrowser() : api!.showBrowser());
  return (
    <section className="wg-browser">
      <div className="wg-tab-strip" title={copy.browserTabLimit}>
        {(browser?.tabs ?? []).map((tab) => <div className={`wg-tab${tab.active ? " is-active" : ""}`} key={tab.id} onClick={() => void run(() => api!.selectBrowserTab(tab.id))} role="tab" aria-selected={tab.active}>
          <BrandMark small /><span title={tab.traceId ? `${tab.title} · ${tab.traceId}` : tab.title}>{browserTabTitle(tab.title, copy)}</span><StateDot state={tab.loading ? "busy" : tabTone(tab.status)} />
          {tab.closable ? <button aria-label={copy.hideTab} onClick={(event) => { event.stopPropagation(); void run(() => api!.closeBrowserTab(tab.id)); }} type="button"><Icon name="close" /></button> : null}
        </div>)}
        <div className="wg-tab-drag draggable" />
      </div>
      <div className="wg-toolbar">
        <div className="wg-toolbar-group"><IconButton disabled={locked || !browser?.canGoBack} icon="back" label={copy.back} onClick={() => void run(() => api!.navigateBrowser("back"))} /><IconButton disabled={locked || !browser?.canGoForward} icon="forward" label={copy.forward} onClick={() => void run(() => api!.navigateBrowser("forward"))} /><IconButton disabled={locked || !visible} icon="reload" label={copy.reload} onClick={() => void run(() => api!.navigateBrowser("reload"))} /></div>
        <div className="wg-address" title={browser?.url || copy.browserAddress}><Icon name="globe" /><span>{formatAddress(browser?.url, copy)}</span></div>
        <div className="wg-zoom"><IconButton icon="minus" label={copy.zoomOut} onClick={() => void run(() => api!.zoomBrowser("out"))} /><button aria-label={copy.zoomReset} className="wg-zoom-reset" onClick={() => void run(() => api!.zoomBrowser("reset"))} type="button">{Math.round((browser?.zoomFactor ?? 1) * 100)}%</button><IconButton icon="plus" label={copy.zoomIn} onClick={() => void run(() => api!.zoomBrowser("in"))} /></div>
        {passkeyAvailable ? <button className="wg-toolbar-action" disabled={passkeyRequested} onClick={() => void passkey()} type="button">{passkeyWaiting ? passkeyRequested ? copy.passkeyImporting : copy.passkeyContinue : copy.passkeySignIn}</button> : null}
        <button className="wg-toolbar-action" onClick={() => void toggle()} type="button">{visible ? copy.hideBrowser : copy.openChatgpt}</button>
        {browser?.loading ? <i className="wg-browser-loading" /> : null}
      </div>
      {selectedManualTab && ["awaiting-user", "sent"].includes(selectedManualTab.manualState ?? "") ? <ManualGuide copy={copy} tab={selectedManualTab} onCancel={() => void run(() => api!.closeBrowserTab(selectedManualTab.id))} onCopy={() => void run(() => api!.copyManualPrompt(selectedManualTab.id))} onSent={() => void run(() => api!.confirmManualSent(selectedManualTab.id))} /> : null}
      <div className="wg-browser-viewport" ref={browserSlotRef}>
        {!visible ? <div className="wg-browser-empty"><BrandMark /><h2>{manual ? copy.browserReady : browser?.authenticated ? copy.noActiveTask : copy.stepAccount}</h2><p>{manual ? copy.manualInteractionBody : browser?.authenticated ? copy.noActiveTaskBody : passkeyWaiting ? copy.passkeyContinueBody : copy.stepAccountBody}</p><div className="wg-browser-actions"><button className="wg-primary" disabled={passkeyWaiting} onClick={() => void toggle()} type="button">{manual || browser?.authenticated ? copy.openChatgpt : copy.signIn}</button>{passkeyAvailable ? <button className="wg-secondary" onClick={() => void passkey()} type="button">{passkeyWaiting ? passkeyRequested ? copy.passkeyImporting : copy.passkeyContinue : copy.passkeySignIn}</button> : null}</div></div> : <div className="wg-browser-underlay"><span>{copy.loading}</span></div>}
      </div>
    </section>
  );
}

function SetupSurface({ activateBrowser, browser, copy, devProfile, setError, showMcp, snapshot, updateState }: {
  activateBrowser: (show?: boolean) => Promise<void>;
  browser: BrowserState | null;
  copy: Copy;
  devProfile: boolean;
  setError: (message: string | null) => void;
  showMcp: () => void;
  snapshot: LauncherSnapshot;
  updateState: (state: LauncherState) => void;
}) {
  const [busy, setBusy] = useState(false);
  const manual = snapshot.state.browserInteractionMode === "manual";
  const managedBrowser = snapshot.browserHost === "managed-chrome";
  const run = async (task: () => Promise<unknown>) => { if (busy) return; setBusy(true); setError(null); try { await task(); } catch (cause) { setError(messageOf(cause)); } finally { setBusy(false); } };
  const signIn = () => run(async () => { await activateBrowser(); await api!.openLogin(); });
  const smoke = () => run(async () => { await activateBrowser(); await api!.smokeTest(); updateState((await api!.snapshot()).state); });
  const install = () => run(async () => { await api!.setupCore(); updateState((await api!.snapshot()).state); });
  return <ContentSurface eyebrow={copy.required} title={devProfile ? copy.devSetupTitle : copy.connectionTitle} subtitle={devProfile ? copy.devSetupSubtitle : manual ? copy.manualInteractionBody : copy.connectionSubtitle}>
    <SectionHeading label={devProfile ? copy.devCoreSetup : copy.coreSetup} />
    <div className="wg-setup-list">
      {!manual ? <><SetupRow complete={browser?.authenticated === true} index={1} title={copy.stepAccount} description={copy.stepAccountBody} action={browser?.authenticated ? copy.signedIn : browser?.status === "loading" ? copy.checkingSignIn : copy.signIn} disabled={busy} onAction={signIn} />{!managedBrowser ? <SetupRow complete={snapshot.smokePassed} index={2} title={copy.stepSmoke} description={copy.stepSmokeBody} action={snapshot.smokePassed ? copy.smokePassed : copy.runSmoke} disabled={busy || browser?.authenticated !== true} onAction={smoke} /> : null}</> : null}
      <SetupRow complete={snapshot.state.codexCatalogVerified === true} index={manual ? 1 : managedBrowser ? 2 : 3} title={devProfile ? copy.devStepInstall : copy.stepInstall} description={devProfile ? copy.devStepInstallBody : copy.stepInstallBody} action={snapshot.state.coreSetupComplete ? devProfile ? copy.devReinstall : copy.reinstall : devProfile ? copy.devInstall : copy.install} disabled={busy || (!manual && !managedBrowser && !snapshot.smokePassed && snapshot.state.coreSetupComplete !== true)} onAction={install} />
    </div>
    {!devProfile && snapshot.state.codexRestartRequired ? <Notice icon="alert" tone="warning">{copy.restartCodex}</Notice> : null}
    <SectionHeading label={copy.mcp} meta={copy.localToolsRequired} spaced />
    {!snapshot.state.mcpSetupComplete ? <Notice icon="alert" tone="warning">{copy.localToolsRequiredBody}</Notice> : null}
    <button className="wg-next-row" disabled={!manual && !snapshot.state.codexCatalogVerified} onClick={showMcp} type="button"><Icon name="mcp" /><span><strong>{devProfile ? copy.devMcpTitle : copy.mcpTitle}</strong><small>{devProfile ? copy.devMcpBody : copy.mcpBody}</small></span><em>{snapshot.state.mcpSetupComplete ? copy.mcpReady : copy.configureMcp}</em><Icon name="chevron" /></button>
  </ContentSurface>;
}

function McpSurface({ copy, devProfile, interactionMode, onDone, operation, setError, snapshot, updateState }: {
  copy: Copy;
  devProfile: boolean;
  interactionMode: BrowserInteractionMode;
  onDone: () => void;
  operation: OperationState | null;
  setError: (message: string | null) => void;
  snapshot: LauncherSnapshot;
  updateState: (state: LauncherState) => void;
}) {
  const changingMode = interactionMode !== snapshot.state.browserInteractionMode;
  const [step, setStep] = useState(changingMode ? 1 : Math.min(2, Math.max(0, snapshot.state.mcpGuideStep || 0)));
  const [tunnelId, setTunnelId] = useState("");
  const [runtimeKey, setRuntimeKey] = useState("");
  const [saved, setSaved] = useState(changingMode ? false : snapshot.mcpCredentialsConfigured);
  const [replace, setReplace] = useState(false);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<DoctorReport | null>(null);
  const manual = interactionMode === "manual";
  const steps = useMemo(() => [copy.mcpStepOne, copy.mcpStepTwo, copy.mcpStepThree], [copy]);
  const move = async (next: number) => { try { setStep(next); updateState(await api!.setMcpStep(next)); } catch (cause) { setError(messageOf(cause)); } };
  const open = async (url: string) => { try { await api!.openExternal(url); } catch (cause) { setError(messageOf(cause)); } };
  const connect = async () => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      await api!.setupMcp({ interactionMode, ...(saved && !replace ? { replace: false } : { tunnelId: tunnelId.trim(), runtimeKey, replace: true }) });
      setTunnelId(""); setRuntimeKey(""); setSaved(true); setReplace(false); updateState((await api!.snapshot()).state); await move(2);
    } catch (cause) { setError(messageOf(cause)); } finally { setBusy(false); }
  };
  const verify = async () => { if (busy) return; setBusy(true); setReport(null); setError(null); try { setReport(await api!.verifyMcp()); updateState((await api!.snapshot()).state); } catch (cause) { setError(messageOf(cause)); } finally { setBusy(false); } };
  return <ContentSurface fit title={devProfile ? copy.devMcpTitle : copy.mcpTitle} subtitle={devProfile ? copy.devMcpSubtitle : copy.mcpSubtitle}>
    {!manual && !changingMode && !snapshot.state.codexCatalogVerified ? <Notice icon="alert" tone="warning">{copy.mcpCatalogRequired}</Notice> : null}
    <div className="wg-wizard-stepper" aria-label={`${step + 1} / 3`}>{steps.map((title, index) => <button className={`wg-wizard-step${index === step ? " is-active" : ""}${index < step || (index === 2 && snapshot.state.mcpSetupComplete && !changingMode) ? " is-complete" : ""}`} disabled={busy || index > step} key={title} onClick={() => void move(index)} type="button"><span>{index < step || (index === 2 && snapshot.state.mcpSetupComplete && !changingMode) ? <Icon name="check" /> : index + 1}</span><em>{title}</em></button>)}</div>
    <section className="wg-wizard-content"><header><span className="wg-wizard-number">0{step + 1}</span><div><h2>{steps[step]}</h2><p>{step === 0 ? copy.mcpStepOneBody : step === 1 ? copy.mcpStepTwoBody : manual ? copy.manualMcpStepThreeBody : copy.mcpStepThreeBody}</p></div></header>
      {step === 0 ? <div className="wg-mcp-actions"><button className="wg-secondary" onClick={() => void open(snapshot.urls.tunnels)} type="button"><Icon name="external" />{copy.openTunnels}</button><button className="wg-secondary" onClick={() => void open(snapshot.urls.keys)} type="button"><Icon name="external" />{copy.openKeys}</button></div> : null}
      {step === 1 ? saved && !replace ? <div className="wg-mcp-actions"><Notice icon="check" tone="success">{copy.credentialsConfigured}<br /><small>{copy.credentialsConfiguredBody}</small></Notice><button className="wg-text-button" disabled={busy} onClick={() => setReplace(true)} type="button">{copy.replaceCredentials}</button></div> : <div className="wg-field-list"><Field label={copy.tunnelId} value={tunnelId} placeholder="tunnel_…" onChange={setTunnelId} /><Field label={copy.runtimeKey} value={runtimeKey} placeholder="sk-…" password onChange={setRuntimeKey} />{saved ? <button className="wg-text-button" disabled={busy} onClick={() => { setTunnelId(""); setRuntimeKey(""); setReplace(false); }} type="button">{copy.keepCredentials}</button> : null}<button className="wg-primary" disabled={busy || !tunnelId.trim() || !runtimeKey} onClick={() => void connect()} type="button">{saved ? copy.reconnect : copy.connect}</button></div> : null}
      {step === 2 ? <><Notice icon="alert" tone="warning">{manual ? copy.manualConnectorNotice : devProfile ? copy.devConnectorNotice : copy.connectorMigrationNotice}</Notice><div className="wg-connector-name"><span>{copy.connectorName}</span><code>{snapshot.connectorNames[interactionMode]}</code></div><div className="wg-mcp-actions"><button className="wg-secondary" onClick={() => void open(snapshot.urls.connectors)} type="button"><Icon name="external" />{copy.openConnectors}</button><button className="wg-primary" disabled={busy || (!manual && !snapshot.state.mcpRuntimeInstalled)} onClick={() => void verify()} type="button">{operation?.status === "running" ? copy.loading : copy.verifyRuntime}</button>{snapshot.state.mcpSetupComplete && !changingMode ? <button className="wg-text-button" onClick={onDone} type="button">{copy.done}</button> : null}</div>{report ? <DoctorSummary copy={copy} language={snapshot.state.language ?? "en"} report={report} /> : null}</> : null}
    </section>
  </ContentSurface>;
}

function ActivitySurface({ copy, language, logs, setError }: { copy: Copy; language: Language; logs: LogRecord[]; setError: (message: string | null) => void }) {
  const [doctor, setDoctor] = useState<DoctorReport | null>(null);
  const [busy, setBusy] = useState(false);
  const diagnose = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try { setDoctor(await api!.doctor()); } catch (cause) { setError(messageOf(cause)); } finally { setBusy(false); }
  };
  return <ContentSurface title={copy.diagnosticsTitle} subtitle={copy.diagnosticsSubtitle}>
    <div className="wg-activity-head"><SectionHeading label={copy.recentActivity} /><div className="wg-activity-actions"><button className="wg-secondary" disabled={busy} onClick={() => void diagnose()} type="button"><Icon name="activity" />{copy.runDoctor}</button><button className="wg-secondary" onClick={() => void api!.exportLogs().catch((cause) => setError(messageOf(cause)))} type="button"><Icon name="external" />{copy.exportSafeLog}</button></div></div>
    {doctor ? <DoctorSummary copy={copy} language={language} report={doctor} /> : null}
    <div className="wg-activity-table">{logs.length === 0 ? <div className="wg-browser-empty"><Icon name="logs" /><span>{copy.noLogs}</span></div> : [...logs].reverse().map((record, index) => <div className="wg-activity-row" key={`${record.at}-${record.event}-${index}`}><StateDot state={record.level === "error" ? "error" : record.level === "warning" ? "busy" : "ready"} /><div><strong>{humanEvent(record.event)}</strong><span>{logDetail(record.detail)}</span></div><time>{formatTime(record.at, language)}</time></div>)}</div>
  </ContentSurface>;
}

function SettingsSurface({ configureInteractionMode, copy, devProfile, language, setError, snapshot, updateState }: {
  configureInteractionMode: (mode: BrowserInteractionMode) => void;
  copy: Copy;
  devProfile: boolean;
  language: Language;
  setError: (message: string | null) => void;
  snapshot: LauncherSnapshot;
  updateState: (state: LauncherState) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [doctor, setDoctor] = useState<DoctorReport | null>(null);
  const [cancelled, setCancelled] = useState(false);
  const [removed, setRemoved] = useState(false);
  const run = async (task: () => Promise<unknown>) => { if (busy) return; setBusy(true); setError(null); try { await task(); } catch (cause) { setError(messageOf(cause)); } finally { setBusy(false); } };
  const setMode = async (mode: BrowserInteractionMode) => { await run(async () => { const result = await api!.setBrowserInteractionMode(mode); updateState(result.state); if (result.credentialsRequired) configureInteractionMode(result.targetMode); }); };
  return <ContentSurface narrow title={devProfile ? copy.devSettingsTitle : copy.settingsTitle}>
    <SectionHeading label={copy.general} />
    <div className="wg-settings-list">
      {!devProfile ? <Setting label={copy.launchAtLogin} body={copy.launchAtLoginBody}><Switch checked={snapshot.state.autoStart} disabled={busy} onChange={(value) => void run(async () => updateState((await api!.setAutostart(value)).state))} /></Setting> : null}
      <div className="wg-setting-row"><div><strong>{copy.interactionMode}</strong><p>{copy.interactionModeBody}</p></div><span className="wg-ink-value">{snapshot.state.browserInteractionMode === "manual" ? copy.manualInteraction : copy.automaticInteraction}</span></div>
      <InteractionPicker copy={copy} disabled={busy} mode={snapshot.state.browserInteractionMode} onChange={(mode) => void setMode(mode)} />
      <Setting label={copy.keepRunningOnClose} body={devProfile ? copy.devKeepRunningBody : copy.keepRunningOnCloseBody}><Switch checked={snapshot.state.keepRunningOnClose} disabled={busy} onChange={(value) => void run(async () => updateState(await api!.setPreference("keepRunningOnClose", value)))} /></Setting>
      <Setting label={copy.showDuringTurns} body={copy.showDuringTurnsBody}><Switch checked={snapshot.state.showBrowserDuringTurns} disabled={busy || snapshot.state.browserInteractionMode === "manual"} onChange={(value) => void run(async () => updateState(await api!.setPreference("showBrowserDuringTurns", value)))} /></Setting>
      <Setting label={copy.biggerContext} body={snapshot.state.browserInteractionMode === "manual" ? copy.manualBiggerContextUnavailable : copy.biggerContextBody}><Switch checked={snapshot.state.experimentalBiggerContext} disabled={busy || snapshot.state.browserInteractionMode === "manual" || snapshot.state.coreSetupComplete !== true} onChange={(value) => void run(async () => updateState(await api!.setBiggerContext(value)))} /></Setting>
      <Setting label={copy.language} body={copy.chooseLanguageHint}><select className="wg-select" value={language} disabled={busy} onChange={(event) => void run(async () => updateState(await api!.setLanguage(event.target.value as Language)))}><option value="en">{copy.english}</option><option value="zh-CN">{copy.chinese}</option><option value="ja">{copy.japanese}</option></select></Setting>
    </div>
    {!devProfile && snapshot.state.codexRestartRequired ? <Notice icon="alert" tone="warning">{copy.restartCodex}</Notice> : null}
    <SectionHeading label={copy.diagnostics} spaced />
    <button className="wg-diagnostic-row" disabled={busy} onClick={() => void run(async () => setDoctor(await api!.doctor()))} type="button"><Icon name="activity" /><span><strong>{copy.runDoctor}</strong><small>{doctor ? doctor.ok ? copy.healthy : copy.needsAttention : copy.status}</small></span><Icon name="chevron" /></button>
    {!devProfile ? <button className="wg-diagnostic-row" disabled={busy} onClick={() => void run(async () => { await api!.cancelTurns(); setCancelled(true); })} type="button"><Icon name="close" /><span><strong>{copy.cancelTurns}</strong><small>{cancelled ? copy.turnsCancelled : copy.cancelTurnsBody}</small></span><Icon name="chevron" /></button> : null}
    {!devProfile ? <button className="wg-diagnostic-row" disabled={busy} onClick={() => void run(async () => { const result = await api!.uninstallIntegration(); if (!result.cancelled) { updateState(result.state); setRemoved(true); } })} type="button"><Icon name="close" /><span><strong>{copy.uninstallIntegration}</strong><small>{removed ? copy.integrationRemoved : copy.uninstallIntegrationBody}</small></span><Icon name="chevron" /></button> : null}
    {doctor ? <DoctorSummary copy={copy} language={language} report={doctor} /> : null}
    <div className="wg-about"><BrandMark small /><span><strong>{copy.product}</strong><small>{devProfile ? "DEV · " : ""}{snapshot.platform} · v{snapshot.version}</small></span><div className="wg-about-links"><button onClick={() => void api!.openExternal(snapshot.urls.github).catch((cause) => setError(messageOf(cause)))} type="button">{copy.project}<Icon name="external" /></button><button onClick={() => void api!.openExternal(DEVELOPER_URL).catch((cause) => setError(messageOf(cause)))} type="button">{copy.developer}<Icon name="external" /></button></div></div>
  </ContentSurface>;
}

function ContentSurface({ children, eyebrow, fit = false, narrow = false, subtitle, title }: { children: ReactNode; eyebrow?: string; fit?: boolean; narrow?: boolean; subtitle?: string; title: string }) {
  return <section className="wg-surface"><div className={`wg-content-scroll${fit ? " is-fit" : ""}${narrow ? " is-narrow" : ""}`}><header className="wg-surface-header">{eyebrow ? <span className="wg-surface-kicker">{eyebrow}</span> : null}<h1>{title}</h1>{subtitle ? <p>{subtitle}</p> : null}</header>{children}</div></section>;
}

function SetupRow({ action, complete, description, disabled, index, onAction, title }: { action: string; complete: boolean; description: string; disabled: boolean; index: number; onAction: () => void; title: string }) {
  return <div className={`wg-setup-row${complete ? " is-complete" : ""}`}><span className="wg-step-index">{complete ? <Icon name="check" /> : index}</span><div className="wg-setup-copy"><div className="wg-setup-heading"><strong>{title}</strong>{complete ? <span className="wg-state-dot is-ready" /> : null}</div><p>{description}</p></div><div className="wg-setup-actions"><button className="wg-secondary" disabled={disabled || complete} onClick={onAction} type="button">{action}</button></div></div>;
}

function InteractionPicker({ copy, disabled, mode, onChange }: { copy: Copy; disabled: boolean; mode: BrowserInteractionMode; onChange: (mode: BrowserInteractionMode) => void }) {
  return <div className="wg-interaction-picker" role="radiogroup" aria-label={copy.interactionMode}><button className={`wg-interaction-option${mode === "automatic" ? " is-selected" : ""}`} aria-checked={mode === "automatic"} disabled={disabled} onClick={() => onChange("automatic")} role="radio" type="button"><span className="wg-interaction-check">{mode === "automatic" ? <Icon name="check" /> : null}</span><span><strong>{copy.automaticInteraction}</strong><small>{copy.automaticInteractionBody}</small></span></button><button className={`wg-interaction-option${mode === "manual" ? " is-selected" : ""}`} aria-checked={mode === "manual"} disabled={disabled} onClick={() => onChange("manual")} role="radio" type="button"><span className="wg-interaction-check">{mode === "manual" ? <Icon name="check" /> : null}</span><span><strong>{copy.manualInteraction}</strong><small>{copy.manualInteractionBody}</small></span></button></div>;
}

function ManualGuide({ copy, onCancel, onCopy, onSent, tab }: { copy: Copy; onCancel: () => void; onCopy: () => void; onSent: () => void; tab: BrowserState["tabs"][number] }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { if (tab.manualState !== "awaiting-user" || !tab.manualDeadlineAt) return; const timer = window.setInterval(() => setNow(Date.now()), 250); return () => window.clearInterval(timer); }, [tab.manualDeadlineAt, tab.manualState]);
  const deadline = tab.manualDeadlineAt ? Date.parse(tab.manualDeadlineAt) : Number.NaN;
  const seconds = Number.isFinite(deadline) ? Math.max(0, Math.ceil((deadline - now) / 1_000)) : 0;
  const waiting = tab.manualState === "awaiting-user";
  return <div className="wg-manual-guide"><div><strong>{waiting ? copy.manualPromptTitle : copy.manualPromptWaiting}</strong>{waiting ? <p>{copy.manualPromptInstruction}</p> : null}</div><span className="wg-manual-status">{waiting ? `${seconds} ${copy.manualPromptSeconds}` : tab.manualState === "sent" ? copy.manualPromptSent : tab.manualState === "running" ? copy.manualPromptRunning : tab.manualState === "completed" ? copy.complete : copy.failed}</span><div className="wg-manual-actions"><button className="wg-secondary" onClick={onCancel} type="button">{copy.manualPromptCancel}</button><button className="wg-secondary" disabled={!tab.canCopyPrompt} onClick={onCopy} type="button">{copy.manualPromptCopy}</button><button className="wg-primary" disabled={!tab.canConfirmSent} onClick={onSent} type="button">{copy.manualPromptSent}</button></div></div>;
}

function Field({ label, onChange, password = false, placeholder, value }: { label: string; onChange: (value: string) => void; password?: boolean; placeholder: string; value: string }) { return <label className="wg-field-row"><span>{label}</span><input autoCapitalize="none" autoCorrect="off" placeholder={placeholder} spellCheck={false} type={password ? "password" : "text"} value={value} onChange={(event) => onChange(event.target.value)} /></label>; }
function Setting({ body, children, label }: { body: string; children: ReactNode; label: string }) { return <div className="wg-setting-row"><div><strong>{label}</strong><p>{body}</p></div>{children}</div>; }
function Switch({ checked, disabled, onChange }: { checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void }) { return <button aria-checked={checked} className={`wg-switch${checked ? " is-on" : ""}`} disabled={disabled} onClick={() => onChange(!checked)} role="switch" type="button"><span /></button>; }
function Notice({ children, icon, tone }: { children: ReactNode; icon: IconName; tone: "warning" | "success" }) { return <div className={`wg-notice tone-${tone}`}><Icon name={icon} /><span>{children}</span></div>; }
function SectionHeading({ label, meta, spaced = false }: { label: string; meta?: string; spaced?: boolean }) { return <div className={`wg-section-heading${spaced ? " is-spaced" : ""}`}><span>{label}</span>{meta ? <small>{meta}</small> : null}</div>; }
function NavGroup({ children, label }: { children: ReactNode; label: string }) { return <div className="wg-nav-group"><h2>{label}</h2>{children}</div>; }
function NavItem({ active, badge, disabled = false, icon, label, onClick }: { active: boolean; badge?: "error" | "required" | "optional"; disabled?: boolean; icon: IconName; label: string; onClick: () => void }) { return <button className={`wg-nav-item${active ? " is-active" : ""}${label.startsWith("Update") ? " is-update" : ""}`} disabled={disabled} onClick={onClick} type="button"><Icon name={icon} /><span>{label}</span>{badge ? <span className="wg-nav-badge"><i className={`wg-state-dot is-${badge === "error" ? "error" : badge === "required" ? "busy" : "ready"}`} /></span> : null}</button>; }
function IconButton({ disabled = false, icon, label, onClick }: { disabled?: boolean; icon: IconName; label: string; onClick: () => void }) { return <button aria-label={label} className="wg-icon-button" disabled={disabled} onClick={onClick} title={label} type="button"><Icon name={icon} /></button>; }
function WelcomeOption({ active, detail, label, marker, onClick }: { active: boolean; detail: string; label: string; marker: string; onClick: () => void }) { return <button aria-checked={active} className={`wg-welcome-option${active ? " is-selected" : ""}`} onClick={onClick} role="radio" type="button"><span>{marker}</span><strong>{label}</strong><small>{detail}</small>{active ? <Icon name="check" /> : null}</button>; }
function StateDot({ state }: { state: "ready" | "busy" | "error" | "idle" }) { return <i className={`wg-state-dot is-${state}`} aria-hidden="true" />; }
function DoctorSummary({ copy, language, report }: { copy: Copy; language: Language; report: DoctorReport }) { const checks = report.ok ? report.checks.slice(-6) : report.checks.filter((check) => check.status !== "ok"); return <div className="wg-doctor"><header><Icon name={report.ok ? "check" : "activity"} /><strong>{report.ok ? copy.healthy : copy.needsAttention}</strong></header>{checks.map((check) => <p key={check.id}><StateDot state={check.status === "ok" ? "ready" : check.status === "warning" ? "busy" : "error"} /><span>{check.status === "ok" ? localizeRuntimeMessage(copy, check.message, check.id, language) : check.message}</span></p>)}</div>; }
function ErrorToast({ copy, message, onDismiss }: { copy: Copy; message: string; onDismiss: () => void }) { return <div className="wg-error-toast"><StateDot state="error" /><span><strong>{copy.error}</strong><p>{message}</p></span><button onClick={onDismiss} type="button">{copy.dismiss}</button></div>; }

function browserTabTitle(title: string, copy: Copy) { if (!title) return copy.temporaryChat; if (title.toLowerCase().includes("temporary")) return copy.temporaryChat; return title; }
function formatAddress(url: string | undefined, copy: Copy) { if (!url) return copy.browserAddress; try { return new URL(url).host.replace(/^www\./, ""); } catch { return url; } }
function tabTone(status: BrowserState["tabs"][number]["status"]): "ready" | "busy" | "error" | "idle" { if (status === "error" || status === "aborted") return "error"; if (status === "loading" || status === "testing" || status === "running") return "busy"; if (status === "ready") return "ready"; return "idle"; }
function messageOf(cause: unknown) { return cause instanceof Error ? cause.message : String(cause); }
function humanEvent(event: string) { return event.replace(/[._-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function logDetail(detail: Record<string, unknown>) { const values = Object.entries(detail).filter(([key]) => !/token|key|cookie|authorization|prompt/i.test(key)).slice(0, 3).map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`); return values.join(" · ") || "Web GPT runtime event"; }
function formatTime(value: string, language: Language) { const date = new Date(value); return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat(language === "zh-CN" ? "zh-CN" : language === "ja" ? "ja-JP" : "en", { hour: "2-digit", minute: "2-digit" }).format(date) : "—"; }
