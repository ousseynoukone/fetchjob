'use client';

import { CheckCircle2, AlertCircle, Info, X } from 'lucide-react';
import { useToastStore } from '@/lib/toast-store';

const ICONS = {
  success: CheckCircle2,
  error: AlertCircle,
  info: Info,
};

const ALERT_CLASS = {
  success: 'alert-success',
  error: 'alert-error',
  info: 'alert-info',
};

export default function ToastContainer() {
  const { toasts, dismiss } = useToastStore();

  if (!toasts.length) return null;

  return (
    <div className="toast toast-end toast-bottom z-[100]">
      {toasts.map((t) => {
        const Icon = ICONS[t.type];
        return (
          <div key={t.id} className={`alert ${ALERT_CLASS[t.type]} shadow-lg text-sm`}>
            <Icon className="w-4 h-4 shrink-0" />
            <span>{t.message}</span>
            <button onClick={() => dismiss(t.id)} className="btn btn-ghost btn-xs btn-circle">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
