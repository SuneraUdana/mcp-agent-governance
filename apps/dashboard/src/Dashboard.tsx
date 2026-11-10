import { useState, type FormEvent, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

type EventType = 'authorization' | 'credential_issued' | 'credential_revoked' | 'tool_invocation';
type AuditEvent = { id: string; correlationId: string; eventType: EventType; occurredAt: string; actorId?: string; agentId?: string; toolId?: string; allowed?: boolean; rationale: string; metadata: Record<string, unknown> };
type Agent = { id: string; name: string; ownerId: string; purpose: string; riskTier: 'low' | 'medium' | 'high'; status: 'active' | 'disabled'; expiresAt?: string; identityMetadata?: Record<string, string>; auditEventCount?: number; lastActivityAt?: string | null };
type Summary = { generatedAt: string; agents: { total: number; active: number; disabled: number; byRiskTier: Record<'low' | 'medium' | 'high', number> }; audit: { total: number; allowed: number; denied: number; byEventType: Record<EventType, number> }; recentEvents: AuditEvent[] };
type Policy = { policyId: string; effect: 'allow' | 'deny'; toolId: string; actorId?: string | null; action: string; reason: string; version: number; status?: string };

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Dashboard API returned ${response.status}`);
  return response.json() as Promise<T>;
}
const labels: Record<EventType, string> = { authorization: 'Authorization', credential_issued: 'Credential issued', credential_revoked: 'Credential revoked', tool_invocation: 'Tool invocation' };

export function Dashboard() {
  const [view, setView] = useState<'overview' | 'agents' | 'policies' | 'audit'>('overview');
  const summary = useQuery({ queryKey: ['dashboard-summary'], queryFn: () => getJson<Summary>('/v1/dashboard/summary'), refetchInterval: 15000 });
  const health = useQuery({ queryKey: ['dashboard-health'], queryFn: () => getJson<{ api: { status: string }; policy: { status: string; detail?: string } }>('/v1/dashboard/health'), refetchInterval: 15000 });
  return <main className="shell">
    <header className="header"><div><p className="eyebrow">MCP AGENT / OPERATIONS</p><h1>Governance control plane</h1><p className="muted">Authenticated, read-only posture and decision observability. Data refreshes from the API; no streaming transport is simulated.</p></div><div className="health-badges"><span className="status">Read-only</span><span className={`status ${health.data?.policy.status === 'ok' ? 'healthy' : 'warning'}`}>Policy: {health.isPending ? 'checking' : health.data?.policy.status ?? 'unavailable'}</span></div></header>
    <nav className="tabs" aria-label="Dashboard sections">{(['overview', 'agents', 'policies', 'audit'] as const).map((item) => <button className={view === item ? 'tab active' : 'tab'} key={item} onClick={() => setView(item)}>{item[0].toUpperCase() + item.slice(1)}</button>)}</nav>
    {summary.isPending && <section className="state"><strong>Loading governance data</strong><span>Fetching current API state…</span></section>}
    {summary.isError && <section className="state error"><strong>Unable to load governance data</strong><span>{summary.error.message}. Verify the API and server-side admin token configuration.</span></section>}
    {summary.data && view === 'overview' && <Overview summary={summary.data} />}
    {view === 'agents' && <AgentsView />}
    {view === 'policies' && <PoliciesView />}
    {view === 'audit' && <AuditView />}
  </main>;
}

function Overview({ summary }: { summary: Summary }) {
  const chartData = (Object.entries(summary.agents.byRiskTier) as Array<['low' | 'medium' | 'high', number]>).map(([riskTier, count]) => ({ riskTier, count }));
  return <div className="content"><section className="cards"><Metric label="Total agents" value={summary.agents.total} detail={`${summary.agents.active} active · ${summary.agents.disabled} disabled`} /><Metric label="Audit events" value={summary.audit.total} detail={`${summary.audit.allowed} allowed · ${summary.audit.denied} denied`} /><Metric label="High-risk agents" value={summary.agents.byRiskTier.high} detail="Review policy coverage regularly" /></section><section className="panel chart-panel"><div className="panel-heading"><div><h2>Agent risk posture</h2><p className="muted">Current registry distribution</p></div></div>{summary.agents.total === 0 ? <Empty message="No agents have been registered yet." /> : <ResponsiveContainer width="100%" height={240}><BarChart data={chartData}><CartesianGrid strokeDasharray="3 3" stroke="#263248" /><XAxis dataKey="riskTier" stroke="#91a0b8" /><YAxis allowDecimals={false} stroke="#91a0b8" /><Tooltip contentStyle={{ background: '#121a2a', border: '1px solid #263248' }} /><Bar dataKey="count" fill="#63d5c6" radius={[6, 6, 0, 0]} /></BarChart></ResponsiveContainer>}</section><section className="panel"><div className="panel-heading"><div><h2>Recent audit activity</h2><p className="muted">Latest events are shown newest first</p></div><span className="muted">{new Date(summary.generatedAt).toLocaleTimeString()}</span></div><EventList events={summary.recentEvents} /></section></div>;
}

function AgentsView() {
  const query = useQuery({ queryKey: ['agents'], queryFn: () => getJson<Agent[]>('/v1/dashboard/agents'), refetchInterval: 15000 });
  return <PanelState query={query} empty="No agents are registered."><div className="table-wrap"><table><thead><tr><th>Agent</th><th>Owner</th><th>Risk</th><th>Status</th><th>Activity</th></tr></thead><tbody>{query.data?.map((agent) => <tr key={agent.id}><td><strong>{agent.name}</strong><small>{agent.id}</small></td><td>{agent.ownerId}</td><td><span className={`pill ${agent.riskTier}`}>{agent.riskTier}</span></td><td>{agent.status}</td><td>{agent.auditEventCount ?? 0} events{agent.lastActivityAt && <small>{new Date(agent.lastActivityAt).toLocaleString()}</small>}</td></tr>)}</tbody></table></div></PanelState>;
}

function PoliciesView() {
  const policies = useQuery({ queryKey: ['policies'], queryFn: () => getJson<Policy[]>('/v1/policies'), refetchInterval: 15000 });
  const [actorId, setActorId] = useState('demo-agent'); const [toolId, setToolId] = useState('demo-tool'); const [action, setAction] = useState('invoke'); const [result, setResult] = useState<{ explanation: string; allowed: boolean } | null>(null); const [error, setError] = useState('');
  async function simulate(event: FormEvent) { event.preventDefault(); setError(''); setResult(null); try { const response = await fetch('/v1/policies/simulate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ actorId, toolId, action }) }); if (!response.ok) throw new Error(`Simulation failed (${response.status})`); setResult(await response.json()); } catch (reason) { setError(reason instanceof Error ? reason.message : 'Simulation unavailable'); } }
  return <div className="content"><PanelState query={policies} empty="No active policies are available."><div className="table-wrap"><table><thead><tr><th>Policy</th><th>Effect</th><th>Target</th><th>Version</th><th>Reason</th></tr></thead><tbody>{policies.data?.map((policy) => <tr key={policy.policyId}><td><strong>{policy.policyId}</strong><small>{policy.status ?? 'active'}</small></td><td><span className={`pill ${policy.effect}`}>{policy.effect}</span></td><td>{policy.actorId ?? '*'} → {policy.toolId} / {policy.action}</td><td>v{policy.version}</td><td>{policy.reason}</td></tr>)}</tbody></table></div></PanelState><section className="panel"><div className="panel-heading"><div><h2>Authenticated policy simulation</h2><p className="muted">Evaluates the real policy service and returns its rationale.</p></div></div><form className="form-grid" onSubmit={simulate}><label>Agent / actor<input value={actorId} onChange={(event) => setActorId(event.target.value)} required /></label><label>Tool<input value={toolId} onChange={(event) => setToolId(event.target.value)} required /></label><label>Action<input value={action} onChange={(event) => setAction(event.target.value)} required /></label><button type="submit">Simulate decision</button></form>{error && <p className="form-error">{error}</p>}{result && <div className={`decision ${result.allowed ? 'allow' : 'deny'}`}><strong>{result.allowed ? 'Allowed' : 'Denied'}</strong><span>{result.explanation}</span></div>}</section></div>;
}

function AuditView() {
  const [filters, setFilters] = useState({ agentId: '', toolId: '', correlationId: '', eventType: '', decision: '' }); const queryString = new URLSearchParams(Object.entries(filters).filter(([, value]) => value)).toString();
  const events = useQuery({ queryKey: ['audit', queryString], queryFn: () => getJson<{ events: AuditEvent[]; total: number }>(`/v1/audit?limit=100&${queryString}`), refetchInterval: 15000 });
  return <div className="content"><section className="panel"><div className="panel-heading"><div><h2>Audit explorer</h2><p className="muted">Every filter is evaluated by the authenticated API.</p></div></div><div className="filter-grid">{Object.keys(filters).map((key) => <label key={key}>{key}<input value={filters[key as keyof typeof filters]} onChange={(event) => setFilters({ ...filters, [key]: event.target.value })} placeholder={key === 'decision' ? 'allowed or denied' : undefined} /></label>)}</div></section><PanelState query={events} empty="No audit events match the current filters."><EventList events={events.data?.events ?? []} /></PanelState></div>;
}

function EventList({ events }: { events: AuditEvent[] }) { return events.length === 0 ? <Empty message="No governed activity has been recorded yet." /> : <div className="events">{events.map((event) => <div className="event" key={event.id}><div className={`event-dot ${event.allowed === false ? 'denied' : ''}`} /><div className="event-main"><strong>{labels[event.eventType]}</strong><span>{event.agentId ?? event.actorId ?? 'system'} · {event.toolId ?? 'control plane'} · {event.rationale}</span><small>{event.correlationId}</small></div><time>{new Date(event.occurredAt).toLocaleString()}</time></div>)}</div>; }
function PanelState<T>({ query, empty, children }: { query: { isPending: boolean; isError: boolean; error: Error | null; data?: T }; empty: string; children: ReactNode }) { if (query.isPending) return <section className="state"><strong>Loading</strong><span>Fetching current data…</span></section>; if (query.isError) return <section className="state error"><strong>Unavailable</strong><span>{query.error?.message ?? 'The API did not return data.'}</span></section>; if (Array.isArray(query.data) && query.data.length === 0) return <section className="panel"><Empty message={empty} /></section>; return <section className="panel">{children}</section>; }
function Metric({ label, value, detail }: { label: string; value: number; detail: string }) { return <article className="metric"><span className="muted">{label}</span><strong>{value}</strong><small>{detail}</small></article>; }
function Empty({ message }: { message: string }) { return <div className="empty">{message}</div>; }
