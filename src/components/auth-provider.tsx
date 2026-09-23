"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { InteractionRequiredAuthError, PublicClientApplication, type AccountInfo } from "@azure/msal-browser";
import { MsalProvider, useMsal } from "@azure/msal-react";
import { ArrowRight, Blocks, CheckCircle2, Github, LockKeyhole, PlayCircle, ShieldCheck, Sparkles } from "lucide-react";

const clientId = process.env.NEXT_PUBLIC_AZURE_CLIENT_ID;
const tenantId = process.env.NEXT_PUBLIC_AZURE_TENANT_ID;
const scope = process.env.NEXT_PUBLIC_AZURE_API_SCOPE || (clientId ? `api://${clientId}/Modernization.Access` : "");
const instance = clientId && tenantId ? new PublicClientApplication({
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
const demoFetch: typeof fetch = (input, init = {}) => fetch(input, { ...init, credentials:"same-origin", headers: { ...init.headers, "X-Modernize-Demo": "true" } });

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(!instance);
  useEffect(() => { if (instance) instance.initialize().then(() => instance.handleRedirectPromise()).finally(() => setReady(true)); }, []);
  if (!ready) return <div className="auth-loading">Securing workspace…</div>;
  return instance ? <MsalProvider instance={instance}><LiveAuth>{children}</LiveAuth></MsalProvider> : <AuthConfigurationError/>;
}

function AuthConfigurationError(){return <main className="auth-loading"><div className="auth-config-error"><LockKeyhole size={25}/><strong>Authentication configuration is unavailable</strong><span>ModernizeAI stopped before opening a workspace. Contact the platform administrator.</span></div></main>}

function LiveAuth({ children }: { children: React.ReactNode }) {
  const { instance: client, accounts } = useMsal();
  const account = accounts[0];
  const [demoSession, setDemoSession] = useState(false);
  const verifyDemoSession=useCallback(async(expected:boolean)=>{for(let attempt=0;attempt<3;attempt+=1){const response=await fetch(`/api/demo/session?check=${Date.now()}`,{credentials:"same-origin",cache:"no-store"});if(response.ok&&Boolean((await response.json()).active)===expected)return;await new Promise(resolve=>window.setTimeout(resolve,50));}throw new Error(`Demo session could not be ${expected?"started":"closed"}.`);},[]);
  const startDemo=useCallback(async()=>{const response=await fetch("/api/demo/session",{method:"POST",credentials:"same-origin"});if(!response.ok)throw new Error("Demo session could not be started.");await verifyDemoSession(true);setDemoSession(true);},[verifyDemoSession]);
  const exitDemo=useCallback(async()=>{const response=await fetch("/api/demo/session",{method:"DELETE",credentials:"same-origin"});if(!response.ok)throw new Error("Demo session could not be closed.");await verifyDemoSession(false);setDemoSession(false);},[verifyDemoSession]);
  const signIn = useCallback(async () => { await client.loginRedirect({ scopes: [scope] }); }, [client]);
  const signOut = useCallback(async () => { if (account) await client.logoutRedirect({ account }); }, [client, account]);
  const authorizedFetch = useCallback(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    if (!account) { await client.loginRedirect({ scopes: [scope] }); return new Promise<Response>(()=>{}); }
    try {
      const token = await client.acquireTokenSilent({ account, scopes: [scope] });
      return fetch(input, { ...init, headers: { ...init.headers, Authorization: `Bearer ${token.accessToken}` } });
    } catch (error) {
      const code=error&&typeof error==="object"&&"errorCode" in error?String(error.errorCode):"";
      if (!(error instanceof InteractionRequiredAuthError)&&code!=="timed_out"&&code!=="monitor_window_timeout") throw error;
      await client.acquireTokenRedirect({ account, scopes: [scope] });
      return new Promise<Response>(()=>{});
    }
  }, [account, client]);
  const effectiveDemo = demoSession && !account;
  const value = useMemo<AuthValue>(() => ({ account, demo: effectiveDemo, signIn, signOut, exitDemo, authorizedFetch: effectiveDemo ? demoFetch : authorizedFetch }), [account, effectiveDemo, signIn, signOut, exitDemo, authorizedFetch]);
  return <AuthContext.Provider value={value}>{account || effectiveDemo ? children : <LoginScreen onSignIn={signIn} onDemo={startDemo} />}</AuthContext.Provider>;
}

function LoginScreen({ onSignIn, onDemo }: { onSignIn: () => Promise<void>; onDemo: () => void }) {
  return <main className="login-shell"><div className="login-aurora one"/><div className="login-aurora two"/><header className="login-header"><div className="login-logo"><div className="brand-mark"><Blocks size={21}/></div><div><strong>Modernize<span>AI</span></strong><small>ENGINEERING INTELLIGENCE</small></div></div><span><ShieldCheck size={14}/> Enterprise secure</span></header><section className="login-content"><div className="login-copy"><div className="login-kicker"><Sparkles size={14}/> MICROSOFT FOUNDRY POWERED</div><h1>Modernize legacy software.<br/><span>Preserve what matters.</span></h1><p>Analyze architecture, generate controlled transformations, inspect every code change, and publish only after quality gates and human approval.</p><div className="login-capabilities"><span><CheckCircle2 size={15}/> Behavior-preserving modernization</span><span><CheckCircle2 size={15}/> Exact before-and-after code review</span><span><CheckCircle2 size={15}/> Isolated branches and draft pull requests</span></div></div><div className="login-card"><div className="login-card-icon"><LockKeyhole size={24}/></div><span className="login-card-label">SECURE WORKSPACE</span><h2>Sign in to ModernizeAI</h2><p>Use your organization account to access connected repositories, modernization runs, approvals, and audit evidence.</p><button className="entra-button" onClick={() => void onSignIn()}><span className="microsoft-mark"><i/><i/><i/><i/></span>Continue with Microsoft<ArrowRight size={16}/></button><div className="login-divider"><span>or explore safely</span></div><button className="demo-button" onClick={onDemo}><PlayCircle size={17}/><span><strong>Open interactive demo</strong><small>Sample data only · no repositories modified</small></span></button><div className="login-security"><ShieldCheck size={14}/>Protected by Microsoft Entra ID</div></div></section><footer className="login-footer"><span>© 2026 ModernizeAI</span><div><span><Github size={13}/>GitHub App integration</span><span><ShieldCheck size={13}/>Enterprise RBAC</span></div></footer></main>;
}

export function useModernizeAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useModernizeAuth must be used inside AuthProvider.");
  return value;
}
