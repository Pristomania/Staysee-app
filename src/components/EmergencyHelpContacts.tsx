import React from 'react';
import { EMERGENCY_HELP_COPY } from '../lib/emergencyHelp';

interface EmergencyHelpContactsProps {
  className?: string;
  linkClassName?: string;
}

/** One renderer for the existing approved contacts in chat and legal/help screens. */
export function EmergencyHelpContacts({
  className = '',
  linkClassName = 'underline underline-offset-4 whitespace-nowrap',
}: EmergencyHelpContactsProps): React.ReactElement {
  return (
    <div className={className}>
      {EMERGENCY_HELP_COPY.rows.map((row, rowIndex) => (
        <p key={rowIndex}>
          {row.map((part, partIndex) => typeof part === 'string' ? (
            <span key={partIndex}>{part}</span>
          ) : (
            <a
              key={partIndex}
              href={part.href}
              className={linkClassName}
              {...(part.href.startsWith('http') ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
            >
              {part.label}
            </a>
          ))}
        </p>
      ))}
    </div>
  );
}
