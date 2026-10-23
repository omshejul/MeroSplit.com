import type { AlertButton, AlertOptions } from 'react-native';

export const Alert = {
  alert(title: string, message = '', buttons: AlertButton[] = [{ text: 'OK' }], _options?: AlertOptions): void {
    const choices = buttons.filter(button => button.style !== 'cancel');
    if (choices.length > 1) throw new Error('This choice needs an explicit on-screen action.');
    const text = [title, message].filter(Boolean).join('\n\n');
    if (buttons.length > 1) {
      if (window.confirm(text)) choices[0]?.onPress?.();
      else buttons.find(button => button.style === 'cancel')?.onPress?.();
    } else { window.alert(text); buttons[0]?.onPress?.(); }
  },
};
