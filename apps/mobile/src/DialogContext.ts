import { createContext } from 'react';

export const DialogContext = createContext({ onDismiss: () => {}, dismissable: true, bodyHeight: 440 });
