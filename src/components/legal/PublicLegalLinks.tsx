import React from 'react';
import { PUBLIC_DOCUMENT_META, PUBLIC_LEGAL_LINKS, PUBLIC_SITE_URL } from '../../lib/publicSite';

export function PublicDocumentLink({document, children, className, pinned = false}: {
  document: keyof typeof PUBLIC_LEGAL_LINKS;
  children?: React.ReactNode;
  className?: string;
  pinned?: boolean;
}) {
  const link = PUBLIC_LEGAL_LINKS[document];
  const meta = document in PUBLIC_DOCUMENT_META ? PUBLIC_DOCUMENT_META[document as keyof typeof PUBLIC_DOCUMENT_META] : null;
  const path = pinned && meta ? link.path.replace('.html', `-v${meta.version}-${meta.sha256.slice(0, 12)}.html`) : link.path;
  return <a href={`${PUBLIC_SITE_URL}${path}`} target="_blank" rel="noopener noreferrer" className={className}>
    {children ?? link.label}
  </a>;
}

export function PublicLegalLinks({className = ''}: {className?: string}) {
  return <nav aria-label="Документы приложения" className={`mt-8 flex flex-wrap justify-center gap-x-5 gap-y-3 text-sm leading-relaxed ${className}`}>
    {(Object.keys(PUBLIC_LEGAL_LINKS) as (keyof typeof PUBLIC_LEGAL_LINKS)[]).map(document =>
      <PublicDocumentLink key={document} document={document} className="underline underline-offset-4 decoration-dotted hover:opacity-80" />)}
  </nav>;
}
