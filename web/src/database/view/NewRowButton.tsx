// « Nouveau ▾ »: new row (from the default template when there is one), row templates list,
// blank row, templates management (edit, default, duplicate, delete, new template). I1: default of this
// view (pin, or a blank row), and recurring templates.
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Check, ChevronDown, Copy, FilePlus2, FileText, LayoutTemplate, Pencil, Pin, PinOff, Plus, Repeat, Star, StarOff, Trash } from 'lucide-react';
import type { Page } from '@oriel/shared';
import { api } from '../../lib/api';
import { navigation } from '../../lib/navigation';
import { useDb } from '../context';
import { errorMessage, templatesKey } from '../data';
import { DbPopover as Popover } from '../ui/DbPopover';
import { IconBtn, MenuDivider, MenuItem, MenuLabel, PanelHeader, stopEscape } from '../ui/primitives';
import type { ViewState } from './types';
import { formatOccurrence, TemplateRecurrencePanel } from './TemplateRecurrencePanel';

function TemplateIcon({ page }: { page: Page }) {
  return page.icon ? <span className="ordb-emoji">{page.icon}</span> : <FileText size={14} />;
}

export function NewRowButton({ vs }: { vs: ViewState }) {
  const { m, databaseId, reportError } = useDb();
  const qc = useQueryClient();
  const [opened, setOpened] = useState(false);
  const [panel, setPanel] = useState<'list' | 'manage' | 'recurrence'>('list');
  const [recurring, setRecurring] = useState<Page | null>(null);
  const templates = vs.templates;
  // Effective default of this view (its own, else the database's), the database's, and the view's own.
  const defaultId = vs.defaultTemplateId;
  const databaseDefault = vs.databaseDefaultTemplateId;
  const viewDefault = vs.config.defaultTemplateId ?? null;
  const recurrenceOf = (id: string) => vs.recurrences.find((r) => r.templateId === id);
  const open = vs.view.type !== 'table';

  const close = () => {
    setOpened(false);
    setPanel('list');
  };
  const newTemplate = async () => {
    close();
    const page = await m.createTemplate('');
    if (page) navigation.openPeek(page.id);
  };
  const removeTemplate = async (t: Page) => {
    try {
      await api.pages.trash(t.id);
    } catch (err) {
      reportError(errorMessage(err));
    }
    void qc.invalidateQueries({ queryKey: templatesKey(databaseId) });
  };

  return (
    <span className="ordb-new-split">
      <button
        type="button"
        className="ordb-btn is-primary is-sm ordb-new-btn"
        onClick={() => vs.createRow(undefined, { open: open || !!defaultId })}
        title={defaultId ? `Nouvelle ligne depuis le modèle « ${templates.find((t) => t.id === defaultId)?.title || 'Sans titre'} »` : undefined}
      >
        <Plus size={14} /> Nouveau
      </button>
      <Popover opened={opened} onChange={(o) => (o ? setOpened(true) : close())} position="bottom-end" width={panel === 'list' ? 290 : 330} shadow="md">
        <Popover.Target>
          <button
            type="button"
            className="ordb-btn is-primary is-sm ordb-new-caret"
            aria-label="Modèles de ligne"
            title="Modèles de ligne"
            onClick={() => (opened ? close() : setOpened(true))}
          >
            <ChevronDown size={14} />
          </button>
        </Popover.Target>
        <Popover.Dropdown className="ordb-dropdown" onKeyDown={stopEscape}>
          {opened && panel === 'list' && (
            <>
              <MenuLabel>Modèles de ligne</MenuLabel>
              {templates.length === 0 && <div className="ordb-menu-hint">Aucun modèle pour cette base.</div>}
              {templates.map((t) => (
                <MenuItem
                  key={t.id}
                  icon={<TemplateIcon page={t} />}
                  label={
                    <>
                      {t.title || 'Sans titre'}
                      {t.id === defaultId && <span className="ordb-template-default">Par défaut</span>}
                    </>
                  }
                  onClick={() => {
                    close();
                    vs.createRow({ templateId: t.id }, { open: true });
                  }}
                />
              ))}
              <MenuDivider />
              <MenuItem
                icon={<FilePlus2 size={14} />}
                label="Nouvelle ligne vide"
                onClick={() => {
                  close();
                  vs.createRow({ templateId: null }, { open });
                }}
              />
              <MenuItem icon={<LayoutTemplate size={14} />} label="Gérer les modèles" chevron onClick={() => setPanel('manage')} />
            </>
          )}
          {opened && panel === 'manage' && (
            <>
              <PanelHeader title="Modèles de ligne" onBack={() => setPanel('list')} />
              {templates.length === 0 && (
                <div className="ordb-menu-hint">
                  Un modèle pré-remplit les propriétés et le contenu des nouvelles lignes (sous-pages comprises).
                </div>
              )}
              {templates.map((t) => (
                <div key={t.id} className="ordb-template-row">
                  <MenuItem
                    icon={<TemplateIcon page={t} />}
                    label={
                      <>
                        {t.title || 'Sans titre'}
                        {t.id === databaseDefault && <span className="ordb-template-default">Par défaut</span>}
                        {t.id === viewDefault && <span className="ordb-template-default">Cette vue</span>}
                        {recurrenceOf(t.id) && <Repeat size={12} className="ordb-template-repeat" aria-label="Répété" />}
                      </>
                    }
                    title="Modifier le modèle"
                    onClick={() => {
                      close();
                      navigation.openPeek(t.id);
                    }}
                  />
                  <IconBtn
                    label={t.id === databaseDefault ? 'Ne plus utiliser par défaut dans la base' : 'Utiliser par défaut dans la base'}
                    active={t.id === databaseDefault}
                    onClick={() => void m.setDefaultTemplate(t.id === databaseDefault ? null : t.id)}
                  >
                    {t.id === databaseDefault ? <StarOff size={14} /> : <Star size={14} />}
                  </IconBtn>
                  <IconBtn
                    label={t.id === viewDefault ? 'Ne plus utiliser par défaut dans cette vue' : 'Utiliser par défaut dans cette vue'}
                    active={t.id === viewDefault}
                    onClick={() => vs.setConfig({ defaultTemplateId: t.id === viewDefault ? null : t.id })}
                  >
                    {t.id === viewDefault ? <PinOff size={14} /> : <Pin size={14} />}
                  </IconBtn>
                  <IconBtn
                    label={recurrenceOf(t.id)?.nextRun ? `Répété — prochaine ligne : ${formatOccurrence(recurrenceOf(t.id)!.nextRun!)}` : 'Répéter'}
                    active={!!recurrenceOf(t.id)}
                    onClick={() => {
                      setRecurring(t);
                      setPanel('recurrence');
                    }}
                  >
                    <Repeat size={14} />
                  </IconBtn>
                  <IconBtn
                    label="Modifier le modèle"
                    onClick={() => {
                      close();
                      navigation.openPeek(t.id);
                    }}
                  >
                    <Pencil size={14} />
                  </IconBtn>
                  <IconBtn label="Dupliquer le modèle" onClick={() => void m.createTemplate(undefined, t.id)}>
                    <Copy size={14} />
                  </IconBtn>
                  <IconBtn label="Supprimer le modèle" onClick={() => void removeTemplate(t)}>
                    <Trash size={14} />
                  </IconBtn>
                </div>
              ))}
              <MenuDivider />
              <MenuItem
                icon={viewDefault === 'blank' ? <Check size={14} /> : <FilePlus2 size={14} />}
                label="Ligne vide par défaut dans cette vue"
                onClick={() => vs.setConfig({ defaultTemplateId: viewDefault === 'blank' ? null : 'blank' })}
              />
              <MenuItem icon={<Plus size={14} />} label="Nouveau modèle" onClick={() => void newTemplate()} />
            </>
          )}
          {opened && panel === 'recurrence' && recurring && (
            <TemplateRecurrencePanel
              key={recurring.id}
              template={recurring}
              info={recurrenceOf(recurring.id)}
              onBack={() => setPanel('manage')}
              onSave={async (recurrence) => {
                const res = await m.setTemplateRecurrence(recurring.id, recurrence);
                if (res) setPanel('manage');
              }}
            />
          )}
        </Popover.Dropdown>
      </Popover>
    </span>
  );
}
