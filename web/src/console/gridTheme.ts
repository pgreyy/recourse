import { studioGridTheme } from 'ag-studio';

/** AG Grid inside custom widgets: Studio's grid theme with the app's type and single accent. */
export const gridTheme = (studioGridTheme as any).withParams({
  fontFamily: "'IBM Plex Sans', system-ui, sans-serif",
  fontSize: 13.5,
  headerFontWeight: 600,
  accentColor: '#0b4f4a',
  foregroundColor: '#14201f',
  borderColor: '#e0ddd5',
  headerBackgroundColor: '#faf9f6',
  headerTextColor: '#44514f',
  rowHoverColor: '#eef4f3',
  selectedRowBackgroundColor: '#e2edeb',
  backgroundColor: '#ffffff',
  wrapperBorderRadius: 6,
});
