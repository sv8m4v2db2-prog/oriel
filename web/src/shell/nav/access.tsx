// Navigation module: operations that change who can read pages (move across sections or teamspaces,
// turning a page into a teamspace) explain their effect and ask for consent first.
import { useEffect, useState } from 'react';
import { Modal, Radio, Stack } from '@mantine/core';
import type { AccessEffect, TeamspaceAccess } from '@oriel/shared';
import { movePage, type MoveTarget } from '../../lib/pages';
import { errorMessage, queryClient } from '../../lib/queryClient';
import { qk } from '../../lib/queryKeys';
import { createStore, useStore } from '../../lib/store';
import { confirmDialog, toast } from '../../lib/ui';
import { appNavigate, pagePath, pageTitle } from '../../lib/util';
import { navApi, nk } from './api';

export const ACCESS_LABELS: Record<TeamspaceAccess, string> = { open: 'Ouvert', closed: 'Fermé', private: 'Privé' };
export const ACCESS_HELP: Record<TeamspaceAccess, string> = {
  open: 'Tous les membres de l’espace de travail le voient, lisent son contenu et peuvent le rejoindre.',
  closed: 'Visible dans l’annuaire ; seuls ses membres lisent son contenu. Les autres demandent l’accès.',
  private: 'Seuls ses membres savent qu’il existe.',
};

const people = (n: number) => (n === 1 ? '1 personne' : `${n} personnes`);

/** One French paragraph describing an access change (counts only). */
export function describeEffect(effect: AccessEffect): string {
  const one = effect.pageCount === 1;
  const subject = one ? 'la page' : `les ${effect.pageCount} pages (page et sous-pages)`;
  const them = one ? 'la' : 'les';
  const to = effect.to;
  const where = to.teamspace
    ? `${one ? 'suivra' : 'suivront'} l’accès de l’espace d’équipe « ${pageTitle(to.teamspace.title)} » (${ACCESS_LABELS[to.teamspace.access].toLowerCase()})`
    : to.visibility === 'private'
      ? `${one ? 'deviendra privée' : 'deviendront privées'} : vous seul ${one ? 'la' : 'les'} verrez`
      : `${one ? 'sera visible' : 'seront visibles'} par tous les membres de l’espace de travail`;
  const parts = [`Après l’opération, ${subject} ${where}.`];
  if (effect.gain > 0) parts.push(`${people(effect.gain)} ${effect.gain === 1 ? 'pourra' : 'pourront'} désormais ${them} lire.`);
  if (effect.lose > 0) parts.push(`${people(effect.lose)} n’y ${effect.lose === 1 ? 'aura' : 'auront'} plus accès.`);
  if (!effect.widens && !effect.narrows) parts.push('Personne ne gagne ni ne perd l’accès.');
  return parts.join(' ');
}

/**
 * Moves a page; when the move changes who can read it, shows the effect and asks for consent
 * (the server refuses a widening across teamspaces without it).
 */
export async function moveWithConsent(workspaceId: string, pageId: string, target: MoveTarget): Promise<void> {
  if (target.parentType !== 'database') {
    let effect: (AccessEffect & { needsConfirm: boolean }) | null = null;
    try {
      effect = await navApi.previewMove(pageId, {
        parentType: target.parentType,
        parentId: target.parentId,
        ...(target.parentType === 'workspace' && (target.visibility === 'workspace' || target.visibility === 'private') ? { visibility: target.visibility } : {}),
      });
    } catch {
      effect = null; // the move itself reports the error
    }
    if (effect && (effect.widens || effect.narrows)) {
      const ok = await confirmDialog({
        title: effect.widens ? 'Élargir l’accès à ces pages ?' : 'Restreindre l’accès à ces pages ?',
        message: describeEffect(effect),
        confirmLabel: 'Déplacer',
      });
      if (!ok) return;
      await movePage(workspaceId, pageId, { ...target, confirmAccess: true });
      return;
    }
  }
  await movePage(workspaceId, pageId, target);
}

// ---------------------------------------------------------------------------
// "Transformer en espace d'équipe"
// ---------------------------------------------------------------------------

interface ConvertRequest {
  workspaceId: string;
  pageId: string;
  title: string;
  /** Default mode widening nothing. */
  initial: TeamspaceAccess;
}

const convertStore = createStore<ConvertRequest | null>(null);

export function openConvertToTeamspace(req: ConvertRequest) {
  convertStore.set(req);
}

export function ConvertTeamspaceHost() {
  const req = useStore(convertStore);
  // Last request, kept while the modal animates out.
  const [shown, setShown] = useState<ConvertRequest | null>(null);
  useEffect(() => {
    if (req) setShown(req);
  }, [req]);
  const [access, setAccess] = useState<TeamspaceAccess>('open');
  const [effect, setEffect] = useState<AccessEffect | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (req) setAccess(req.initial);
  }, [req]);

  useEffect(() => {
    if (!req) return;
    let live = true;
    setEffect(null);
    setError(null);
    navApi
      .previewConversion(req.pageId, { access })
      .then((e) => live && setEffect(e))
      .catch((e) => live && setError(errorMessage(e, 'Transformation impossible.')));
    return () => {
      live = false;
    };
  }, [req, access]);

  const close = () => convertStore.set(null);
  const submit = async () => {
    if (!req) return;
    setBusy(true);
    try {
      await navApi.convert(req.pageId, { access, confirmAccess: true });
      void queryClient.invalidateQueries({ queryKey: qk.tree(req.workspaceId) });
      void queryClient.invalidateQueries({ queryKey: qk.page(req.pageId) });
      void queryClient.invalidateQueries({ queryKey: nk.teamspaces(req.workspaceId) });
      toast.success('Espace d’équipe créé');
      close();
      appNavigate(pagePath(req.workspaceId, req.pageId));
    } catch (e) {
      setError(errorMessage(e, 'Transformation impossible.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal opened={!!req} onClose={close} title="Transformer en espace d’équipe" centered size="md" radius="md">
      {shown && (
        <div className="nav-dialog">
          <p className="dialog-text">
            « {pageTitle(shown.title)} » et ses sous-pages deviendront un espace d’équipe, à la racine de l’espace de travail. Vous en serez
            propriétaire.
          </p>
          <Radio.Group value={access} onChange={(v) => setAccess(v as TeamspaceAccess)} label="Accès" name="teamspace-access">
            <Stack gap={8} mt={6}>
              {(['open', 'closed', 'private'] as const).map((a) => (
                <Radio key={a} value={a} label={ACCESS_LABELS[a]} description={ACCESS_HELP[a]} />
              ))}
            </Stack>
          </Radio.Group>
          <div className={`nav-effect${effect && (effect.widens || effect.narrows) ? ' is-change' : ''}`} role="status" aria-live="polite">
            {error ? <span className="nav-effect__error">{error}</span> : effect ? describeEffect(effect) : 'Calcul de l’effet…'}
          </div>
          <div className="dialog-actions">
            <button type="button" className="btn btn--secondary" onClick={close}>
              Annuler
            </button>
            <button type="button" className="btn btn--primary" disabled={!effect || busy || !!error} onClick={() => void submit()}>
              {effect && (effect.widens || effect.narrows) ? 'Confirmer le changement d’accès' : 'Transformer'}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
