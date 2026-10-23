import { createContext, useContext } from 'react';
import { EMPTY_WIDGET_PRESENTATION, type WidgetPresentation } from './widgetPresentation';
const Context = createContext<WidgetPresentation>(EMPTY_WIDGET_PRESENTATION);
export const WidgetPresentationProvider = Context.Provider;
export const useWidgetPresentation = () => useContext(Context);
