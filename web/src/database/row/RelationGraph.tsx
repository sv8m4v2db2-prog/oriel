// Relation schema diagram (D29, SPEC §5.9): hand-written SVG, loaded on demand. The database in the
// centre, the databases it relates to around it, one labelled edge per relation property. Clicking a
// database opens it. The server only lists databases and relations the viewer can see.
import { useQuery } from '@tanstack/react-query';
import { Database } from 'lucide-react';
import { api } from '../../lib/api';
import { navigation } from '../../lib/navigation';
import { layoutRelationGraph, NODE_H, NODE_W } from './relationGraphLayout';
import './g3.css';

const truncate = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

export default function RelationGraph({ databaseId, onNavigate }: { databaseId: string; onNavigate: () => void }) {
  const q = useQuery({ queryKey: ['relation-graph', databaseId], queryFn: () => api.databases.relationGraph(databaseId), staleTime: 10_000 });
  if (q.isLoading) return <div className="ordb-skeleton is-short" />;
  if (q.isError || !q.data) return <div className="ordb-error">Schéma indisponible.</div>;
  const { nodes, edges, width, height } = layoutRelationGraph(q.data);
  if (nodes.length <= 1) {
    return (
      <div className="ordb-relgraph-empty">
        <Database size={16} /> Cette base n'est reliée à aucune autre base que vous pouvez voir.
      </div>
    );
  }
  return (
    <div className="ordb-relgraph">
      <svg viewBox={`0 0 ${width} ${height}`} width={width} style={{ maxWidth: '100%', height: 'auto' }} role="img" aria-label={`Schéma des relations de « ${nodes[0]!.title || 'Sans titre'} »`}>
        <defs>
          <marker id="ordb-relgraph-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" className="ordb-relgraph-arrowhead" />
          </marker>
        </defs>
        {edges.map((e) => (
          <g key={e.key} className="ordb-relgraph-edge">
            <path
              d={e.path}
              fill="none"
              markerEnd={e.self ? undefined : 'url(#ordb-relgraph-arrow)'}
              markerStart={e.twoWay && !e.self ? 'url(#ordb-relgraph-arrow)' : undefined}
              className={e.twoWay ? 'is-two-way' : undefined}
            />
            <text x={e.labelX} y={e.labelY} textAnchor="middle" dominantBaseline="middle" className="ordb-relgraph-label">
              <title>{e.label}</title>
              {truncate(e.label, 34)}
            </text>
          </g>
        ))}
        {nodes.map((n) => (
          <g
            key={n.id}
            className={n.center ? 'ordb-relgraph-node is-center' : 'ordb-relgraph-node'}
            transform={`translate(${n.x - NODE_W / 2} ${n.y - NODE_H / 2})`}
            role="link"
            tabIndex={0}
            aria-label={`Ouvrir « ${n.title || 'Sans titre'} »`}
            onClick={() => {
              onNavigate();
              navigation.openPage(n.id);
            }}
            onKeyDown={(ev) => {
              if (ev.key === 'Enter' || ev.key === ' ') {
                ev.preventDefault();
                onNavigate();
                navigation.openPage(n.id);
              }
            }}
          >
            <rect width={NODE_W} height={NODE_H} rx={8} />
            <text x={NODE_W / 2} y={NODE_H / 2} textAnchor="middle" dominantBaseline="middle">
              <title>{n.title || 'Sans titre'}</title>
              {truncate(`${n.icon ? `${n.icon} ` : ''}${n.title || 'Sans titre'}`, 22)}
            </text>
          </g>
        ))}
      </svg>
      <p className="ordb-menu-hint">
        Une flèche par propriété relation, de la base qui la porte vers la base liée ; double flèche : relation
        bidirectionnelle. Cliquez sur une base pour l'ouvrir.
      </p>
    </div>
  );
}
