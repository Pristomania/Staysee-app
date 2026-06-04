import { useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { useApp } from '../../context/AppContext';
import { supabase } from '../../lib/supabase';
import { Sparkles } from 'lucide-react';

const concerns = [
  { id: 'anxiety', label: 'тревога' },
  { id: 'relationships', label: 'отношения' },
  { id: 'fatigue', label: 'усталость' },
  { id: 'chaos', label: 'хаос в голове' },
  { id: 'loneliness', label: 'одиночество' },
  { id: 'understanding', label: 'хочу понять себя' },
  { id: 'talk', label: 'просто поговорить' },
];

export function OnboardingScreen() {
  const { user, refreshProfile } = useAuth();
  const { replaceNavigation } = useApp();
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSelect = async () => {
    if (!selected || !user) return;

    setLoading(true);

    await supabase
      .from('profiles')
      .update({
        primary_concern: selected,
        onboarding_completed: true,
      })
      .eq('id', user.id);

    await refreshProfile();
    replaceNavigation('main');
    setLoading(false);
  };

  const handleSkip = async () => {
    if (!user) return;
    setLoading(true);
    await supabase
      .from('profiles')
      .update({ onboarding_completed: true })
      .eq('id', user.id);
    await refreshProfile();
    replaceNavigation('main');
    setLoading(false);
  };

  return (
    <div className="min-h-screen gradient-bg flex flex-col px-6 pt-16 pb-8 relative overflow-hidden">
      {/* Subtle glow */}
      <div className="absolute top-40 left-10 w-72 h-72 bg-glow-soft rounded-full blur-3xl opacity-15 animate-glow-pulse" />
      <div className="absolute bottom-40 right-10 w-80 h-80 bg-glow-warm rounded-full blur-3xl opacity-10 animate-glow-pulse" style={{ animationDelay: '2s' }} />

      {/* Content */}
      <div className="flex-1 flex flex-col max-w-lg mx-auto w-full animate-fade-in relative z-10">
        {/* Icon */}
        <div className="mb-10 flex justify-center">
          <div className="w-16 h-16 rounded-full bg-midnight-700/40 flex items-center justify-center">
            <Sparkles className="w-8 h-8 text-cream-300" strokeWidth={1.5} />
          </div>
        </div>

        {/* Question */}
        <h1 className="text-xl sm:text-2xl font-light text-cream-100 text-center mb-3 leading-relaxed">
          Что сейчас больше всего
        </h1>
        <h2 className="text-xl sm:text-2xl font-light text-cream-100 text-center mb-12 leading-relaxed">
          забирает ваши силы?
        </h2>

        {/* Options */}
        <div className="space-y-3 flex-1">
          {concerns.map((concern, index) => (
            <button
              key={concern.id}
              onClick={() => setSelected(concern.id)}
              disabled={loading}
              className={`w-full py-4 px-6 rounded-2xl text-left transition-all duration-400 ${selected === concern.id
                ? 'bg-cream-400/15 border-cream-300/40 text-cream-100'
                : 'bg-midnight-700/20 border-cream-300/5 hover:bg-midnight-700/30 text-cream-300 hover:text-cream-200'
                } border animate-slide-up`}
              style={{ animationDelay: `${index * 80}ms` }}
            >
              <span className="font-light text-lg">{concern.label}</span>
            </button>
          ))}
        </div>

        <div className="mt-8 space-y-3">
          {selected && (
            <button
              onClick={() => void handleSelect()}
              disabled={loading}
              className="w-full py-4 bg-cream-400/10 hover:bg-cream-400/15 border border-cream-300/20 rounded-2xl text-cream-200 font-light tracking-wide transition-all duration-300 disabled:opacity-50"
            >
              {loading ? 'Сохраняем...' : 'Продолжить'}
            </button>
          )}
          <button
            type="button"
            onClick={() => void handleSkip()}
            disabled={loading}
            className="w-full py-2 text-cream-400/60 text-sm font-light underline underline-offset-4 decoration-dotted"
          >
            Пропустить
          </button>
        </div>
      </div>

      {/* Bottom gradient */}
      <div className="absolute bottom-0 left-0 right-0 h-32 warm-gradient" />
    </div>
  );
}
