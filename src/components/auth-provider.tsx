"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { InteractionRequiredAuthError, PublicClientApplication, type AccountInfo } from "@azure/msal-browser";
import { MsalProvider, useMsal } from "@azure/msal-react";
import { ArrowRight, Blocks, CheckCircle2, Github, LockKeyhole, PlayCircle, ShieldCheck, Sparkles } from "lucide-react";
import {requestJson} from "@/lib/request-json";
import {workspaceRequestHeaders} from "@/lib/request-headers";

const clientId = process.env.NEXT_PUBLIC_AZURE_CLIENT_ID?.trim();
const tenantId = process.env.NEXT_PUBLIC_AZURE_TENANT_ID?.trim();
const scope = process.env.NEXT_PUBLIC_AZURE_API_SCOPE || (clientId ? `api://${clientId}/Modernization.Access` : "");
const identifier=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const instance = clientId && tenantId && identifier.test(clientId) && identifier.test(tenantId) ? new PublicClientApplication({
  auth: { clientId, authority: `https://login.microsoftonline.com/${tenantId}`, redirectUri: typeof window === "undefined" ? undefined : window.location.origin },
  cache: { cacheLocation: "sessionStorage" },
}) : undefined;

interface AuthValue {
  account?: AccountInfo;
  demo: boolean;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  exitDemo: () => void;
  authorizedFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}
const AuthContext = createContext<AuthValue | undefined>(undefined);
const demoFetch: typeof fetch = (input, init = {}) => {const headers=workspaceRequestHeaders(input,init.headers,window.location.origin);headers.delete("Authorization");headers.set("X-Modernize-Demo","true");return fetch(input,{...init,credentials:"same-origin",headers});};

export function AuthProvider({ children,allowLocalDemo=false }: { children: React.ReactNode;allowLocalDemo?:boolean }) {
  const [ready, setReady] = useState(!instance||allowLocalDemo);
  const [initializationError,setInitializationError]=useState("");
  useEffect(() => { if (instance&&!allowLocalDemo) instance.initialize().then(() => instance.handleRedirectPromise()).catch(error=>{console.error("Authentication initialization failed",error);setInitializationError("Authentication initialization failed. Reload or contact the platform administrator.");}).finally(() => setReady(true)); }, [allowLocalDemo]);
  if (!ready) return <div className="auth-loading">Securing workspace…</div>;
  if(initializationError)return <AuthConfigurationError detail={initializationError}/>;
  return allowLocalDemo?<LocalDemoAuth>{children}</LocalDemoAuth>:instance ? <MsalProvider instance={instance}><LiveAuth>{children}</LiveAuth></MsalProvider>:<AuthConfigurationError/>;
}

function AuthConfigurationError({detail}:{detail?:string}){return <main className="auth-loading"><div className="auth-config-error"><LockKeyhole size={25}/><strong>Authentication configuration is unavailable</strong><span>{detail||"ModernizeAI stopped before opening a workspace. Configure Microsoft Entra, or explicitly enable an isolated local demo."}</span></div></main>}

function useDemoSession(){
  const [active,setActive]=useState(false);
  const [error,setError]=useState("");
  useEffect(()=>{let mounted=true;void requestJson<{active:boolean}>(fetch,"/api/demo/session",{credentials:"same-origin",cache:"no-store"},15000,"Demo session status timed out.").then(result=>{if(mounted)setActive(result.active);}).catch(caught=>{if(mounted)setError(caught instanceof Error?caught.message:"Demo session could not be loaded.");});return()=>{mounted=false;};},[]);
  const change=useCallback(async(expected:boolean)=>{
    setError("");
    try{
      await requestJson(fetch,"/api/demo/session",{method:expected?"POST":"DELETE",credentials:"same-origin"},15000,"Demo session update timed out.");
      const result=await requestJson<{active:boolean}>(fetch,`/api/demo/session?check=${Date.now()}`,{credentials:"same-origin",cache:"no-store"},15000,"Demo session confirmation timed out.");
      if(result.active!==expected)throw new Error(`Demo session could not be ${expected?"started":"closed"}.`);
      setActive(expected);
    }catch(caught){setError(caught instanceof Error?caught.message:"Demo session update failed.");throw caught;}
  },[]);
  const start=useCallback(()=>change(true),[change]);
  const exit=useCallback(async()=>{try{await change(false);}catch(caught){console.error("Demo session exit failed",caught);}},[change]);
  return {active,error,start,exit};
}

function LocalDemoAuth({children}:{children:React.ReactNode}){
  const session=useDemoSession();
  const signIn=useCallback(async()=>{throw new Error("Live sign-in requires Microsoft Entra configuration. This workspace is an explicitly enabled local demo.");},[]);
  const value=useMemo<AuthValue>(()=>({demo:true,signIn,signOut:session.exit,exitDemo:session.exit,authorizedFetch:demoFetch}),[signIn,session.exit]);
  return <AuthContext.Provider value={value}>{session.error&&<p role="alert" className="error-note">{session.error}</p>}{session.active?children:<LoginScreen onSignIn={signIn} onDemo={session.start}/>}</AuthContext.Provider>;
}

function LiveAuth({ children }: { children: React.ReactNode }) {
  const { instance: client, accounts } = useMsal();
  const account = accounts[0];
  const demoSession=useDemoSession();
  const exitDemo=demoSession.exit;
  const signIn = useCallback(async () => { await client.loginRedirect({ scopes: [scope] }); }, [client]);
  const signOut = useCallback(async () => { if (account) await client.logoutRedirect({ account }); }, [client, account]);
  const authorizedFetch = useCallback(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const headers=workspaceRequestHeaders(input,init.headers,window.location.origin);
    if (!account) { await client.loginRedirect({ scopes: [scope] }); return new Promise<Response>(()=>{}); }
    try {
      const token = await client.acquireTokenSilent({ account, scopes: [scope] });
      if(!token.accessToken)throw new Error("The identity provider returned no access token. Sign in again.");
      headers.set("Authorization",`Bearer ${token.accessToken}`);
      return fetch(input, { ...init, headers });
    } catch (error) {
      const code=error&&typeof error==="object"&&"errorCode" in error?String(error.errorCode):"";
      if (!(error instanceof InteractionRequiredAuthError)&&code!=="timed_out"&&code!=="monitor_window_timeout") throw error;
      await client.acquireTokenRedirect({ account, scopes: [scope] });
      return new Promise<Response>(()=>{});
    }
  }, [account, client]);
  const effectiveDemo = demoSession.active && !account;
  const value = useMemo<AuthValue>(() => ({ account, demo: effectiveDemo, signIn, signOut, exitDemo, authorizedFetch: effectiveDemo ? demoFetch : authorizedFetch }), [account, effectiveDemo, signIn, signOut, exitDemo, authorizedFetch]);
  return <AuthContext.Provider value={value}>{demoSession.error&&<p role="alert" className="error-note">{demoSession.error}</p>}{account || effectiveDemo ? children : <LoginScreen onSignIn={signIn} onDemo={demoSession.start} />}</AuthContext.Provider>;
}

function LoginScreen({ onSignIn, onDemo }: { onSignIn: () => Promise<void>; onDemo: () => Promise<void> }) {
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const perform=async(action:()=>Promise<void>)=>{if(busy)return;setBusy(true);setError("");try{await action();}catch(caught){setError(caught instanceof Error?caught.message:"The workspace could not be opened.");}finally{setBusy(false);}};
  return <main className="login-shell">
    <div className="login-aurora one"/><div className="login-aurora two"/>
    <header className="login-header"><div className="login-logo"><div className="brand-mark"><Blocks size={21}/></div><div><strong>Modernize<span>AI</span></strong><small>ENGINEERING INTELLIGENCE</small></div></div><span><ShieldCheck size={14}/> Enterprise secure</span></header>
    <section className="login-content">
      <div className="login-copy"><div className="login-kicker"><Sparkles size={14}/> MICROSOFT FOUNDRY POWERED</div><h1>Modernize legacy software.<br/><span>Preserve what matters.</span></h1><p>Analyze architecture, generate controlled transformations, inspect every code change, and publish only after quality gates and human approval.</p><div className="login-capabilities"><span><CheckCircle2 size={15}/> Behavior-preserving modernization</span><span><CheckCircle2 size={15}/> Exact before-and-after code review</span><span><CheckCircle2 size={15}/> Isolated branches and draft pull requests</span></div></div>
      <div className="login-card">
        <div className="login-card-icon"><LockKeyhole size={24}/></div><span className="login-card-label">SECURE WORKSPACE</span><h2>Sign in to ModernizeAI</h2><p>Use your organization account to access connected repositories, modernization runs, approvals, and audit evidence.</p>
        <button className="entra-button" disabled={busy} onClick={()=>void perform(onSignIn)}><span className="microsoft-mark"><i/><i/><i/><i/></span>Continue with Microsoft<ArrowRight size={16}/></button>
        <div className="login-divider"><span>or explore safely</span></div>
        <button className="demo-button" disabled={busy} onClick={()=>void perform(onDemo)}><PlayCircle size={17}/><span><strong>{busy?"Opening workspace...":"Open interactive demo"}</strong><small>Sample data only · no repositories modified</small></span></button>
        {error&&<p className="error-note" role="alert">{error}</p>}
        <div className="login-security"><ShieldCheck size={14}/>Live access protected by Microsoft Entra ID</div>
      </div>
    </section>
    <footer className="login-footer"><span>© 2026 ModernizeAI</span><div><span><Github size={13}/>GitHub App integration</span><span><ShieldCheck size={13}/>Enterprise RBAC</span></div></footer>
  </main>;
}

export function useModernizeAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useModernizeAuth must be used inside AuthProvider.");
  return value;
}
