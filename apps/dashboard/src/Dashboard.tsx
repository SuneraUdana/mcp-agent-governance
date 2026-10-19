import { useQuery } from '@tanstack/react-query';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

type EventType = 'authorization' | 'credential_issued' | 'credential_revoked' | 'tool_invocation';
type AuditEvent = {
  id: string;
  correlationId: string;
  eventType: EventType;
  occurredAt: string;
  allowed?: boolean;
  rationale: string;
  metadata: Record<string, unknown>;
};
type Summary = {
  generatedAt: string;
  agents: { total: number; active: number; disabled: number; byRiskTier: Record<'low' | 'medium' | 'high', number> };
  audit: { total: number; allowed: number; denied: number; byEventType: Record<EventType, number> };
  recentEvents: AuditEvent[];
};

async function getSummary(): Promise<Summary> {
  const response = await fetch('/v1/dashboard/summary');
  if (!response.ok) throw new Error(`Dashboard API returned ${response.status}`);
  return response.json() as Promise<Summary>;
}

const labels: Record<EventType, string> = {
  authorization: 'Authorization',
  credential_issued: 'Credential issued',
  credential_revoked: 'Credential revoked',
  tool_invocation: 'Tool invocation',
};

export function Dashboard() {
  const summary = useQuery({ queryKey: ['dashboard-summary'], queryFn: getSummary });

  return (
    <main className="shell">
      <header className="header">
        <div>
          <p className="eyebrow">MCP AGENT / OPERATIONS</p>
          <h1>Governance overview</h1>
          <p className="muted">A read-only view of agent posture and recent governed activity.</p>
        </div>
        <span className="status">Read-only</span>
      </header>
      {summary.isPending && <section className="state"><strong>Loading overview</strong><span>Fetching current governance metadata…</span></section>}
      {summary.isError && <section className="state error"><strong>Unable to load overview</strong><span>{summary.error.message}. Check the API URL and administrative token configuration.</span></section>}
      {summary.data && <Overview summary={summary.data} />}
    </main>
  );
}

function Overview({ summary }: { summary: Summary }) {
  const chartData = (Object.entries(summary.agents.byRiskTier) as Array<['low' | 'medium' | 'high', number]>).map(([riskTier, count]) => ({ riskTier, count }));
  return (
    <div className="content">
      <section className="cards">
        <Metric label="Total agents" value={summary.agents.total} detail={`${summary.agents.active} active · ${summary.agents.disabled} disabled`} />
        <Metric label="Audit events" value={summary.audit.total} detail={`${summary.audit.allowed} allowed · ${summary.audit.denied} denied`} />
        <Metric label="High-risk agents" value={summary.agents.byRiskTier.high} detail="Review policy coverage regularly" />
      </section>
      <section className="panel chart-panel">
        <div className="panel-heading"><div><h2>Agent risk posture</h2><p className="muted">Current registry distribution</p></div></div>
        {summary.agents.total === 0 ? <Empty message="No agents have been registered yet." /> : <ResponsiveContainer width="100%" height={240}><BarChart data={chartData}><CartesianGrid strokeDasharray="3 3" stroke="#263248" /><XAxis dataKey="riskTier" stroke="#91a0b8" /><YAxis allowDecimals={false} stroke="#91a0b8" /><Tooltip contentStyle={{ background: '#121a2a', border: '1px solid #263248' }} /><Bar dataKey="count" fill="#63d5c6" radius={[6, 6, 0, 0]} /></BarChart></ResponsiveContainer>}
      </section>
      <section className="panel">
        <div className="panel-heading"><div><h2>Recent audit activity</h2><p className="muted">Latest events are shown newest first</p></div><span className="muted">{new Date(summary.generatedAt).toLocaleTimeString()}</span></div>
        {summary.recentEvents.length === 0 ? <Empty message="No governed activity has been recorded yet." /> : <div className="events">{summary.recentEvents.map((event) => <div className="event" key={event.id}><div className={`event-dot ${event.allowed === false ? 'denied' : ''}`} /><div className="event-main"><strong>{labels[event.eventType]}</strong><span>{event.rationale}</span></div><time>{new Date(event.occurredAt).toLocaleString()}</time></div>)}</div>}
      </section>
    </div>
  );
}

function Metric({ label, value, detail }: { label: string; value: number; detail: string }) {
  return <article className="metric"><span className="muted">{label}</span><strong>{value}</strong><small>{detail}</small></article>;
}

function Empty({ message }: { message: string }) {
  return <div className="empty">{message}</div>;
}
