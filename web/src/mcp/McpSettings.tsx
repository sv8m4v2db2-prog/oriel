// Settings › API et MCP: personal API tokens (list / create / revoke) and the configuration of the
// Oriel MCP server for Claude Desktop and Claude Code.
import { useMemo, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Modal } from '@mantine/core';
import { Bot, Copy, KeyRound, ShieldAlert, Terminal, X } from 'lucide-react';
import {
  API_TOKEN_LIMITS,
  API_TOKEN_SCOPE_LABELS,
  type ApiTokenInfo,
  type ApiTokenScope,
  type CreatedApiToken,
} from '@oriel/shared';
import { errorMessage } from '../lib/queryClient';
import { confirmDialog, toast } from '../lib/ui';
import { copyToClipboard, formatDate, formatWhen } from '../lib/util';
import { useWorkspaces } from '../lib/session';
import { isLocalDesktop } from '../lib/desktop';
import { ErrorState, Skeleton, Spinner } from '../components/common';
import { mcpKeys, tokensApi } from './api';
import { claudeCodeSnippet, claudeDesktopSnippet } from './snippets';
import './mcp.css';

const EXPIRY_CHOICES: Array<{ days: number | null; label: string }> = [
  { days: 30, label: '30 jours' },
  { days: 90, label: '90 jours' },
  { days: 365, label: '1 an' },
  { days: null, label: 'Jamais' },
];

function Section({ title, description, children }: { title: string; description?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="settings-section">
      <h2 className="settings-section__title">{title}</h2>
      {description && <p className="settings-section__desc">{description}</p>}
      <div className="settings-section__body">{children}</div>
    </section>
  );
}

function CopyBlock({ label, text, icon }: { label: string; text: string; icon?: React.ReactNode }) {
  return (
    <div className="mcp-snippet">
      <div className="mcp-snippet__head">
        <span className="mcp-snippet__label">
          {icon}
          {label}
        </span>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={async () => {
            if (await copyToClipboard(text)) toast.success('Copié dans le presse-papiers');
          }}
        >
          <Copy size={14} /> Copier
        </button>
      </div>
      <pre className="mcp-snippet__code">{text}</pre>
    </div>
  );
}

function Snippets({ token, workspaceId }: { token?: string | null; workspaceId?: string | null }) {
  const url = window.location.origin;
  return (
    <div className="mcp-snippets">
      <CopyBlock label="Claude Desktop — claude_desktop_config.json" icon={<Bot size={14} />} text={claudeDesktopSnippet({ url, token, workspaceId })} />
      <CopyBlock label="Claude Code — terminal" icon={<Terminal size={14} />} text={claudeCodeSnippet({ url, token, workspaceId })} />
    </div>
  );
}

function scopeTag(scope: ApiTokenScope) {
  return (
    <span className="tag" data-color={scope === 'write' ? 'orange' : 'blue'}>
      {API_TOKEN_SCOPE_LABELS[scope]}
    </span>
  );
}

export function McpSettings() {
  const queryClient = useQueryClient();
  const workspaces = useWorkspaces();
  const tokens = useQuery({ queryKey: mcpKeys.tokens, queryFn: tokensApi.list });
  const [name, setName] = useState('Claude');
  const [scope, setScope] = useState<ApiTokenScope>('read');
  const [workspaceId, setWorkspaceId] = useState<string>('');
  const [days, setDays] = useState<number | null>(90);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreatedApiToken | null>(null);
  const workspaceList = useMemo(() => workspaces.data ?? [], [workspaces.data]);

  const refresh = () => queryClient.invalidateQueries({ queryKey: mcpKeys.tokens });

  const create = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setCreating(true);
    try {
      const token = await tokensApi.create({ name: name.trim(), scope, workspaceId: workspaceId || null, expiresInDays: days });
      setCreated(token);
      await refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setCreating(false);
    }
  };

  const revoke = async (t: ApiTokenInfo) => {
    const ok = await confirmDialog({
      title: `Révoquer « ${t.name} » ?`,
      message: 'Les applications qui utilisent ce jeton (Claude Desktop, Claude Code…) perdront immédiatement l’accès à Oriel.',
      confirmLabel: 'Révoquer',
      danger: true,
    });
    if (!ok) return;
    try {
      await tokensApi.revoke(t.id);
      toast.success('Jeton révoqué');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      void refresh();
    }
  };

  const list = tokens.data?.tokens ?? [];
  const atLimit = list.length >= API_TOKEN_LIMITS.maxPerUser;

  return (
    <div className="mcp-settings">
      <h1 className="settings__title">API et MCP</h1>
      <p className="mcp-intro">
        <Bot size={15} />
        <span>
          Un <strong>jeton d’API personnel</strong> permet à Claude (Claude Desktop, Claude Code…) d’utiliser Oriel avec <strong>vos droits</strong>{' '}
          grâce au serveur MCP d’Oriel : rechercher et lire des pages, rédiger du contenu, interroger et remplir des bases de données,
          commenter. Le guide complet est dans <code>docs/MCP.md</code>.
        </span>
      </p>
      {isLocalDesktop && (
        <div className="mcp-note is-warning">
          <ShieldAlert size={15} />
          <span>
            Mode local : tout programme de ce Mac peut déjà ouvrir une session sur ce serveur embarqué. Les jetons n’y apportent aucune isolation
            supplémentaire, et le port du serveur change à chaque lancement.
          </span>
        </div>
      )}

      <Section
        title="Nouveau jeton"
        description="Choisissez le minimum nécessaire : lecture seule si Claude doit seulement consulter, un seul espace si possible, et une date d’expiration."
      >
        <form className="mcp-form" onSubmit={(e) => void create(e)}>
          <label className="field mcp-form__name">
            <span className="field-label">Nom</span>
            <input
              className="input"
              value={name}
              maxLength={API_TOKEN_LIMITS.nameMax}
              placeholder="Claude Desktop sur mon Mac"
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="field">
            <span className="field-label">Droits</span>
            <select className="input select" value={scope} onChange={(e) => setScope(e.target.value as ApiTokenScope)}>
              <option value="read">{API_TOKEN_SCOPE_LABELS.read}</option>
              <option value="write">{API_TOKEN_SCOPE_LABELS.write}</option>
            </select>
          </label>
          <label className="field">
            <span className="field-label">Espace</span>
            <select className="input select" value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)}>
              <option value="">Tous mes espaces</option>
              {workspaceList.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.icon ? `${w.icon} ` : ''}
                  {w.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field-label">Expire après</span>
            <select className="input select" value={days === null ? 'never' : String(days)} onChange={(e) => setDays(e.target.value === 'never' ? null : Number(e.target.value))}>
              {EXPIRY_CHOICES.map((c) => (
                <option key={c.label} value={c.days === null ? 'never' : String(c.days)}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="btn btn--primary" disabled={creating || !name.trim() || atLimit}>
            {creating ? <Spinner size={14} /> : <KeyRound size={15} />} Créer le jeton
          </button>
        </form>
        {atLimit && <p className="field-hint">Limite de {API_TOKEN_LIMITS.maxPerUser} jetons atteinte : révoquez-en un pour en créer un autre.</p>}
      </Section>

      <Section title="Vos jetons" description="Un jeton est révoqué automatiquement quand vous changez de mot de passe, ou quand vous quittez l’espace auquel il est limité.">
        {tokens.isError ? (
          <ErrorState message={errorMessage(tokens.error)} onRetry={() => void tokens.refetch()} />
        ) : !tokens.data ? (
          <Skeleton height={60} />
        ) : list.length === 0 ? (
          <p className="field-hint">Aucun jeton pour le moment.</p>
        ) : (
          <ul className="mcp-token-list">
            {list.map((t) => (
              <li key={t.id} className={`mcp-token${t.expired ? ' is-expired' : ''}`}>
                <div className="mcp-token__main">
                  <span className="mcp-token__name">{t.name}</span>
                  <code className="mcp-token__prefix">{t.prefix}…</code>
                  {scopeTag(t.scope)}
                  {t.expired && (
                    <span className="tag" data-color="red">
                      Expiré
                    </span>
                  )}
                </div>
                <div className="mcp-token__meta">
                  {t.workspaceId ? `Espace : ${t.workspaceName ?? 'inaccessible'}` : 'Tous vos espaces'} · Créé le {formatDate(t.createdAt)} ·{' '}
                  {t.lastUsedAt ? `Utilisé ${formatWhen(t.lastUsedAt)}` : 'Jamais utilisé'} ·{' '}
                  {t.expiresAt ? `${t.expired ? 'Expiré' : 'Expire'} le ${formatDate(t.expiresAt)}` : 'Sans expiration'}
                </div>
                <button type="button" className="btn btn--ghost btn--sm btn--danger-text mcp-token__revoke" onClick={() => void revoke(t)}>
                  <X size={14} /> Révoquer
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        title="Configurer Claude"
        description={
          <>
            Construisez d’abord le serveur MCP dans votre copie d’Oriel (<code>npm ci && npm run build -w mcp</code>), adaptez le chemin
            ci-dessous, puis remplacez <code>or_VOTRE_JETON</code> par votre jeton.
          </>
        }
      >
        <Snippets />
      </Section>

      <Modal opened={!!created} onClose={() => setCreated(null)} title="Copiez votre jeton maintenant" centered size="lg" zIndex={400}>
        {created && (
          <div className="mcp-created">
            <div className="mcp-note is-warning">
              <ShieldAlert size={15} />
              <span>
                Ce jeton ne sera <strong>plus jamais affiché</strong>. Conservez-le comme un mot de passe : il donne accès à Oriel avec vos droits (
                {API_TOKEN_SCOPE_LABELS[created.scope].toLowerCase()}).
              </span>
            </div>
            <CopyBlock label={`Jeton « ${created.name} »`} icon={<KeyRound size={14} />} text={created.token} />
            <p className="field-hint">Configuration prête à coller (adaptez seulement le chemin du fichier) :</p>
            <Snippets token={created.token} workspaceId={created.workspaceId} />
            <div className="mcp-created__actions">
              <button type="button" className="btn btn--primary" onClick={() => setCreated(null)}>
                J’ai copié le jeton
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
