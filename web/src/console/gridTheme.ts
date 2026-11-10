import { studioGridTheme } from 'ag-studio';

/** AG Grid inside custom widgets: Studio's grid theme with the app's type, paper and single accent. */
export const gridTheme = (studioGridTheme as any).withParams({
  fontFamily: "'IBM Plex Sans', system-ui, sans-serif",
  fontSize: 13.5,
  headerFontWeight: 600,
  accentColor: '#0b4f4a',
  foregroundColor: '#161a19',
  borderColor: '#e2dccf',
  headerBackgroundColor: '#f9f6ef',
  headerTextColor: '#3d4542',
  rowHoverColor: '#f1f4ef',
  selectedRowBackgroundColor: '#e2ece8',
  backgroundColor: '#fffdf8',
  wrapperBorderRadius: 4,
});
