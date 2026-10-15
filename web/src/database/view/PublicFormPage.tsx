// Public page of a form (/share/:databaseId/form/:viewId): anonymous answers to a form view shared with
// people without an account. Its database does not need to be published (QA-VIEW-04): the page reads
// the form definition only (GET /api/public/forms/:vid: texts, public questions and their properties,
// never rows). The database id of the link and the `?lien=` of linked blocks (links shared before)
// are not used: the view id is enough. The server decides whether answers are accepted (form shared,
// open, database live) and which questions an anonymous visitor may answer. No session is used.
import { useEffect, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ClipboardList, Moon, Sun } from 'lucide-react';
import { isNotFound } from '../../lib/queryClient';
import { toggleTheme, useTheme } from '../../lib/theme';
import { EmptyState, ErrorState, Logo, PageSkeleton } from '../../components/common';
import { dbExtrasApi } from '../api';
import { FormFill } from '../layouts/FormView';
import { normalizeFormConfig } from '../logic/viewConfig';
import '../../shell/shell.css';

export function PublicFormPage() {
  const { viewId = '' } = useParams();
  const theme = useTheme();
  const query = useQuery({ queryKey: ['public-form', viewId], queryFn: () => dbExtrasApi.publicForm(viewId), retry: false });
  const data = query.data;
  const view = data?.view;
  const properties = data?.properties;
  const form = useMemo(() => (data ? normalizeFormConfig(data.form) : undefined), [data]);
  const title = form?.title?.trim() || view?.name || 'Formulaire';

  useEffect(() => {
    if (view) document.title = `${title} · Oriel`;
  }, [view, title]);

  let body;
  if (query.isLoading) body = <PageSkeleton />;
  else if (query.isError && !isNotFound(query.error)) body = <ErrorState onRetry={() => void query.refetch()} />;
  else if (!view || !form || !properties || !form.isPublic) {
    body = (
      <div className="center-content">
        <EmptyState icon={<ClipboardList size={26} />} title="Formulaire indisponible">
          Ce formulaire n’est pas partagé publiquement, ou il n’existe plus.
        </EmptyState>
      </div>
    );
  } else {
    body = (
      <div className="ordb-root ordb-form is-public">
        <FormFill view={view} form={form} properties={properties} mode="public" />
      </div>
    );
  }

  return (
    <div className="public">
      <header className="public__bar">
        <span className="breadcrumbs__item is-current">
          <ClipboardList size={15} />
          <span>{view ? title : 'Formulaire'}</span>
        </span>
        <span style={{ flex: 1 }} />
        <button type="button" className="icon-btn" aria-label="Changer de thème" onClick={toggleTheme}>
          {theme.resolved === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
        </button>
      </header>
      <main className="public__main">{body}</main>
      <footer className="public__footer">
        <a href="/" className="public__made">
          <Logo size={16} /> Créé avec Oriel
        </a>
      </footer>
    </div>
  );
}
