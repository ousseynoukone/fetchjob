export const SUPPORTED_PLATFORMS = ['linkedin', 'indeed', 'france_travail', 'hellowork'] as const;
export type SupportedPlatform = (typeof SUPPORTED_PLATFORMS)[number];
