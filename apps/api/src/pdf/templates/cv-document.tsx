import { Document, Page, Text, View, StyleSheet, Svg, Path } from '@react-pdf/renderer';

export interface CVData {
  fullName: string;
  headline: string;
  email: string;
  phone: string;
  location: string;
  summary?: string;
  links?: { type: string; url: string; label?: string }[];
  skillGroups?: { label: string; items: string[] }[];
  experiences?: {
    role: string;
    company: string;
    location?: string;
    period: string;
    bullets: string[];
  }[];
  projects?: { name: string; period?: string; bullets: string[] }[];
  education?: {
    degree: string;
    school: string;
    location?: string;
    period: string;
  }[];
  certifications?: { name: string; issuer: string; date: string }[];
  languages?: { name: string; level: string }[];
  interests?: string[];
  options?: { fontSize?: number; compact?: boolean; accent?: string; template?: string };
}

export function CVDocument({ cv }: { cv: CVData }) {
  if (cv.options?.template === 'ats') {
    return <AtsCVDocument cv={cv} />;
  }
  return <SidebarCVDocument cv={cv} />;
}

// Rough content-volume estimate used to shrink font sizes and spacing so a
// dense CV still fits on a single A4 page instead of spilling onto a second.
// Not a real layout measurement — a calibrated heuristic based on character
// counts, tuned against real multi-experience/multi-project CVs.
export function estimateFitScale(cv: CVData, { twoColumn }: { twoColumn: boolean }): number {
  let volume = 0;
  volume += cv.summary?.length || 0;

  for (const exp of cv.experiences || []) {
    volume += 40;
    for (const b of exp.bullets || []) volume += b.length + 8;
  }
  for (const proj of cv.projects || []) {
    volume += 30;
    for (const b of proj.bullets || []) volume += b.length + 8;
  }
  volume += (cv.education?.length || 0) * 55;
  volume += (cv.certifications?.length || 0) * 35;
  volume += (cv.languages?.length || 0) * 18;
  for (const g of cv.skillGroups || []) {
    volume += 18;
    for (const item of g.items || []) volume += item.length + 3;
  }
  volume += (cv.interests?.length || 0) * 10;

  // Two-column layouts fit roughly 1.6x as much content per page as a
  // single ATS column, so scale the thresholds accordingly.
  const factor = twoColumn ? 1.6 : 1;
  const t = (n: number) => n * factor;

  if (volume < t(1600)) return 1;
  if (volume < t(2300)) return 0.92;
  if (volume < t(3000)) return 0.85;
  if (volume < t(3700)) return 0.78;
  if (volume < t(4500)) return 0.71;
  if (volume < t(5400)) return 0.65;
  return 0.6;
}

// The default fontSize a fit scale of 1 was calibrated against — the
// "Taille de police" control in the CV builder is a multiplier off this,
// not an absolute point size, so a short CV can be sized up to actually
// fill the page instead of always rendering at the smallest safe size.
const BASE_FONT_SIZE = 11;

function getUserScale(cv: CVData): number {
  return (cv.options?.fontSize || BASE_FONT_SIZE) / BASE_FONT_SIZE;
}

// ============================================================================
// ATS-friendly template: single column, plain text, standard font, no
// graphics or colored blocks in the reading path — built to parse cleanly
// through applicant tracking systems, not just to look good on screen.
// ============================================================================

function getAtsStyles(scale: number) {
  const pagePadding = Math.max(22, 36 * scale);
  return StyleSheet.create({
    page: {
      padding: pagePadding,
      fontSize: 10 * scale,
      fontFamily: 'Helvetica',
      color: '#111111',
    },
    name: {
      fontSize: 18 * scale,
      fontWeight: 700,
    },
    headline: {
      fontSize: 11 * scale,
      marginTop: 2,
    },
    contactLine: {
      fontSize: 9 * scale,
      marginTop: 6 * scale,
      color: '#333333',
    },
    section: {
      marginTop: 14 * scale,
    },
    sectionTitle: {
      fontSize: 10.5 * scale,
      fontWeight: 700,
      textTransform: 'uppercase',
      borderBottomWidth: 1,
      borderBottomColor: '#111111',
      paddingBottom: 3 * scale,
      marginBottom: 6 * scale,
    },
    summary: {
      fontSize: 9.5 * scale,
      lineHeight: 1.4,
    },
    entry: {
      marginBottom: 8 * scale,
    },
    entryTitleLine: {
      fontSize: 10 * scale,
      fontWeight: 700,
    },
    entrySubLine: {
      fontSize: 9.5 * scale,
      marginTop: 1,
    },
    bullet: {
      fontSize: 9.5 * scale,
      marginTop: 2 * scale,
      marginLeft: 10 * scale,
      lineHeight: 1.35,
    },
    skillLine: {
      fontSize: 9.5 * scale,
      marginBottom: 3 * scale,
    },
    skillLabel: {
      fontWeight: 700,
    },
  });
}

function AtsCVDocument({ cv }: { cv: CVData }) {
  const scale = getUserScale(cv) * estimateFitScale(cv, { twoColumn: false });
  const atsStyles = getAtsStyles(scale);

  const contactParts = [cv.email, cv.phone, cv.location, ...(cv.links || []).map((l) => l.label || l.url)].filter(
    Boolean,
  );

  return (
    <Document title={cv.fullName || 'CV'}>
      <Page size="A4" style={atsStyles.page}>
        <Text style={atsStyles.name}>{cv.fullName}</Text>
        {!!cv.headline && <Text style={atsStyles.headline}>{cv.headline}</Text>}
        {!!contactParts.length && <Text style={atsStyles.contactLine}>{contactParts.join(' | ')}</Text>}

        {!!cv.summary && (
          <View style={atsStyles.section}>
            <Text style={atsStyles.sectionTitle}>Résumé</Text>
            <Text style={atsStyles.summary}>{cv.summary}</Text>
          </View>
        )}

        {!!cv.experiences?.length && (
          <View style={atsStyles.section}>
            <Text style={atsStyles.sectionTitle}>Expérience professionnelle</Text>
            {cv.experiences.map((exp, idx) => (
              <View style={atsStyles.entry} key={idx}>
                <Text style={atsStyles.entryTitleLine}>
                  {exp.role} — {exp.company}
                </Text>
                <Text style={atsStyles.entrySubLine}>
                  {[exp.location, exp.period].filter(Boolean).join(' | ')}
                </Text>
                {exp.bullets?.map((bullet, bidx) => (
                  <Text style={atsStyles.bullet} key={bidx}>
                    - {bullet}
                  </Text>
                ))}
              </View>
            ))}
          </View>
        )}

        {!!cv.projects?.length && (
          <View style={atsStyles.section}>
            <Text style={atsStyles.sectionTitle}>Projets</Text>
            {cv.projects.map((proj, idx) => (
              <View style={atsStyles.entry} key={idx}>
                <Text style={atsStyles.entryTitleLine}>
                  {proj.name}
                  {proj.period ? ` — ${proj.period}` : ''}
                </Text>
                {proj.bullets?.map((bullet, bidx) => (
                  <Text style={atsStyles.bullet} key={bidx}>
                    - {bullet}
                  </Text>
                ))}
              </View>
            ))}
          </View>
        )}

        {!!cv.education?.length && (
          <View style={atsStyles.section}>
            <Text style={atsStyles.sectionTitle}>Formation</Text>
            {cv.education.map((edu, idx) => (
              <View style={atsStyles.entry} key={idx}>
                <Text style={atsStyles.entryTitleLine}>{edu.degree}</Text>
                <Text style={atsStyles.entrySubLine}>
                  {[edu.school, edu.location, edu.period].filter(Boolean).join(' | ')}
                </Text>
              </View>
            ))}
          </View>
        )}

        {!!cv.skillGroups?.length && (
          <View style={atsStyles.section}>
            <Text style={atsStyles.sectionTitle}>Compétences</Text>
            {cv.skillGroups.map((group, idx) => (
              <Text style={atsStyles.skillLine} key={idx}>
                <Text style={atsStyles.skillLabel}>{group.label}: </Text>
                {group.items.join(', ')}
              </Text>
            ))}
          </View>
        )}

        {!!cv.certifications?.length && (
          <View style={atsStyles.section}>
            <Text style={atsStyles.sectionTitle}>Certifications</Text>
            {cv.certifications.map((cert, idx) => (
              <Text style={atsStyles.skillLine} key={idx}>
                {cert.name} — {cert.issuer} ({cert.date})
              </Text>
            ))}
          </View>
        )}

        {!!cv.languages?.length && (
          <View style={atsStyles.section}>
            <Text style={atsStyles.sectionTitle}>Langues</Text>
            <Text style={atsStyles.skillLine}>
              {cv.languages.map((l) => `${l.name} (${l.level})`).join(', ')}
            </Text>
          </View>
        )}

        {!!cv.interests?.length && (
          <View style={atsStyles.section}>
            <Text style={atsStyles.sectionTitle}>Centres d'intérêt</Text>
            <Text style={atsStyles.skillLine}>{cv.interests.join(', ')}</Text>
          </View>
        )}
      </Page>
    </Document>
  );
}

// ============================================================================
// Sidebar template: two-column layout on a white background with small
// contact/meta icons and skill pills — matches the on-screen preview.
// ============================================================================

function Icon({ path, color, size = 8 }: { path: string; color: string; size?: number }) {
  return (
    <Svg viewBox="0 0 20 20" width={size} height={size}>
      <Path d={path} fill={color} />
    </Svg>
  );
}

const ICONS = {
  mail: 'M3 4a2 2 0 0 0-2 2v1.161l8.441 4.221a1.25 1.25 0 0 0 1.118 0L19 7.162V6a2 2 0 0 0-2-2H3ZM19 8.839l-7.77 3.885a2.75 2.75 0 0 1-2.46 0L1 8.839V14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8.839Z',
  phone: 'M2 3.5A1.5 1.5 0 0 1 3.5 2h1.148a1.5 1.5 0 0 1 1.465 1.175l.716 3.223a1.5 1.5 0 0 1-1.052 1.767l-.933.267c-.41.117-.643.555-.48.95a11.542 11.542 0 0 0 6.254 6.254c.395.163.833-.07.95-.48l.267-.933a1.5 1.5 0 0 1 1.767-1.052l3.223.716A1.5 1.5 0 0 1 18 15.352V16.5a1.5 1.5 0 0 1-1.5 1.5H15c-1.149 0-2.263-.15-3.326-.43A13.022 13.022 0 0 1 2.43 8.326 13.019 13.019 0 0 1 2 5V3.5Z',
  pin: 'M9.69 18.933s.11.02.308-.066l.002-.001a11.842 11.842 0 0 0 .976-.544 13.731 13.731 0 0 0 2.273-1.765C14.906 14.988 17 12.493 17 9A7 7 0 1 0 3 9c0 3.492 1.698 5.988 3.355 7.584a13.731 13.731 0 0 0 2.273 1.765 11.842 11.842 0 0 0 .976.544l.086.038ZM10 11.25a2.25 2.25 0 1 0 0-4.5 2.25 2.25 0 0 0 0 4.5Z',
  briefcase: 'M6 3.75A2.75 2.75 0 0 1 8.75 1h2.5A2.75 2.75 0 0 1 14 3.75v.443c.572.055 1.14.122 1.706.2C17.053 4.582 18 5.75 18 7.07v3.469c0 1.126-.694 2.191-1.83 2.54-1.952.599-4.024.921-6.17.921s-4.219-.322-6.17-.921C2.694 12.73 2 11.665 2 10.539V7.07c0-1.321.947-2.489 2.294-2.676A41.047 41.047 0 0 1 6 4.193V3.75Zm6.5 0v.325a41.622 41.622 0 0 0-5 0V3.75c0-.69.56-1.25 1.25-1.25h2.5c.69 0 1.25.56 1.25 1.25Z',
  calendar: 'M5.75 2a.75.75 0 0 1 .75.75V4h7V2.75a.75.75 0 0 1 1.5 0V4h.25A2.75 2.75 0 0 1 18 6.75v8.5A2.75 2.75 0 0 1 15.25 18H4.75A2.75 2.75 0 0 1 2 15.25v-8.5A2.75 2.75 0 0 1 4.75 4H5V2.75A.75.75 0 0 1 5.75 2Zm-1 5.5c-.69 0-1.25.56-1.25 1.25v6.5c0 .69.56 1.25 1.25 1.25h10.5c.69 0 1.25-.56 1.25-1.25v-6.5c0-.69-.56-1.25-1.25-1.25H4.75Z',
  link: 'M12.232 4.232a2.5 2.5 0 0 1 3.536 3.536l-1.225 1.224a.75.75 0 0 0 1.061 1.06l1.224-1.224a4 4 0 0 0-5.656-5.656l-3 3a4 4 0 0 0 .225 5.865.75.75 0 0 0 .977-1.138 2.5 2.5 0 0 1-.142-3.667l3-3ZM11.603 7.603a.75.75 0 0 0-.977 1.138 2.5 2.5 0 0 1 .142 3.667l-3 3a2.5 2.5 0 0 1-3.536-3.536l1.225-1.224a.75.75 0 0 0-1.061-1.06l-1.224 1.224a4 4 0 1 0 5.656 5.656l3-3a4 4 0 0 0-.225-5.865Z',
};

const DEFAULT_SIDEBAR_ACCENT = '#2d5bff';
const SIDEBAR_BG = '#111827';

function getSidebarStyles(ACCENT: string, scale: number) {
  const leftPadding = Math.max(14, 20 * scale);
  const rightPadding = Math.max(14, 22 * scale);
  return StyleSheet.create({
    page: {
      flexDirection: 'row',
      fontSize: 9.5 * scale,
      fontFamily: 'Helvetica',
      color: '#0f172a',
    },
    left: {
      width: '34%',
      padding: leftPadding,
      backgroundColor: SIDEBAR_BG,
    },
    contactBlock: {
      marginBottom: 16 * scale,
    },
    contactRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 5,
      marginBottom: 5 * scale,
    },
    contactText: {
      fontSize: 8 * scale,
      color: '#cbd5e1',
    },
    sideBlock: {
      marginBottom: 14 * scale,
    },
    sideTitle: {
      fontSize: 8 * scale,
      fontWeight: 700,
      textTransform: 'uppercase',
      letterSpacing: 1,
      color: '#f8fafc',
      borderBottomWidth: 1.5,
      borderBottomColor: ACCENT,
      paddingBottom: 4 * scale,
      marginBottom: 8 * scale,
    },
    skillGroupLabel: {
      fontSize: 7.5 * scale,
      fontWeight: 700,
      textTransform: 'uppercase',
      color: ACCENT,
      marginBottom: 2 * scale,
    },
    skillItemsText: {
      fontSize: 7.5 * scale,
      color: '#cbd5e1',
      lineHeight: 1.4,
      marginBottom: 8 * scale,
    },
    sideText: {
      fontSize: 8 * scale,
      color: '#cbd5e1',
      marginBottom: 3 * scale,
    },
    right: {
      width: '66%',
      padding: rightPadding,
    },
    headerName: {
      fontSize: 19 * scale,
      fontWeight: 700,
      lineHeight: 1.15,
    },
    headerHeadline: {
      fontSize: 9.5 * scale,
      fontWeight: 700,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
      color: ACCENT,
      marginTop: 3 * scale,
      paddingBottom: 10 * scale,
      marginBottom: 14 * scale,
      borderBottomWidth: 2,
      borderBottomColor: '#e2e8f0',
    },
    summary: {
      fontSize: 9 * scale,
      color: '#475569',
      lineHeight: 1.5,
      marginBottom: 14 * scale,
    },
    section: {
      marginBottom: 14 * scale,
    },
    sectionTitle: {
      fontSize: 9.5 * scale,
      fontWeight: 700,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
      borderBottomWidth: 2,
      borderBottomColor: ACCENT,
      paddingBottom: 5 * scale,
      marginBottom: 9 * scale,
    },
    entry: {
      marginBottom: 10 * scale,
    },
    entryTitle: {
      fontSize: 9.5 * scale,
      fontWeight: 700,
    },
    expHeaderRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    expCompanyLine: {
      flexDirection: 'row',
      alignItems: 'center',
    },
    expDot: {
      width: 5,
      height: 5,
      borderRadius: 2.5,
      backgroundColor: ACCENT,
      marginRight: 5,
    },
    expRole: {
      fontSize: 8.5 * scale,
      fontWeight: 700,
      color: ACCENT,
      marginTop: 3 * scale,
      marginBottom: 3 * scale,
    },
    bulletRow: {
      flexDirection: 'row',
      marginTop: 2 * scale,
    },
    bulletDot: {
      fontSize: 8 * scale,
      color: ACCENT,
      marginRight: 4,
    },
    bullet: {
      fontSize: 8 * scale,
      color: '#475569',
      flex: 1,
      lineHeight: 1.35,
    },
    entryRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
    },
    entryPeriod: {
      fontSize: 7.5 * scale,
      fontWeight: 700,
      color: '#64748b',
    },
    eduRow: {
      flexDirection: 'row',
      marginBottom: 9 * scale,
    },
    eduPeriod: {
      width: '28%',
      fontSize: 7.5 * scale,
      fontWeight: 700,
      color: '#64748b',
    },
    eduDegree: {
      fontSize: 9 * scale,
      fontWeight: 700,
    },
    eduSchool: {
      fontSize: 8 * scale,
      color: '#64748b',
      marginTop: 1,
    },
    certRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'baseline',
      marginBottom: 5 * scale,
    },
    certName: {
      fontSize: 8.5 * scale,
      fontWeight: 700,
      color: ACCENT,
    },
    certIssuer: {
      fontSize: 7.5 * scale,
      color: '#64748b',
    },
    certDate: {
      fontSize: 7.5 * scale,
      color: '#64748b',
    },
  });
}

function Bullet({ text, styles }: { text: string; styles: ReturnType<typeof getSidebarStyles> }) {
  return (
    <View style={styles.bulletRow}>
      <Text style={styles.bulletDot}>•</Text>
      <Text style={styles.bullet}>{text}</Text>
    </View>
  );
}

function SidebarCVDocument({ cv }: { cv: CVData }) {
  const ACCENT = cv.options?.accent || DEFAULT_SIDEBAR_ACCENT;
  const scale = getUserScale(cv) * estimateFitScale(cv, { twoColumn: true });
  const styles = getSidebarStyles(ACCENT, scale);

  return (
    <Document title={cv.fullName || 'CV'}>
      <Page size="A4" style={styles.page}>
        <View style={styles.left}>
          {(!!cv.email || !!cv.phone || !!cv.location || !!cv.links?.length) && (
            <View style={styles.sideBlock}>
              <Text style={styles.sideTitle}>Contact</Text>
              <View style={styles.contactBlock}>
                {!!cv.email && (
                  <View style={styles.contactRow}>
                    <Icon path={ICONS.mail} color={ACCENT} />
                    <Text style={styles.contactText}>{cv.email}</Text>
                  </View>
                )}
                {!!cv.phone && (
                  <View style={styles.contactRow}>
                    <Icon path={ICONS.phone} color={ACCENT} />
                    <Text style={styles.contactText}>{cv.phone}</Text>
                  </View>
                )}
                {!!cv.location && (
                  <View style={styles.contactRow}>
                    <Icon path={ICONS.pin} color={ACCENT} />
                    <Text style={styles.contactText}>{cv.location}</Text>
                  </View>
                )}
                {(cv.links || []).map((link, idx) => (
                  <View style={styles.contactRow} key={idx}>
                    <Icon path={ICONS.link} color={ACCENT} />
                    <Text style={styles.contactText}>{link.label || link.url}</Text>
                  </View>
                ))}
              </View>
            </View>
          )}

          {!!cv.skillGroups?.length && (
            <View style={styles.sideBlock}>
              <Text style={styles.sideTitle}>Expertise technique</Text>
              {cv.skillGroups.map((group, idx) => (
                <View key={idx}>
                  <Text style={styles.skillGroupLabel}>{group.label} :</Text>
                  <Text style={styles.skillItemsText}>{group.items.join(', ')}</Text>
                </View>
              ))}
            </View>
          )}

          {!!cv.languages?.length && (
            <View style={styles.sideBlock}>
              <Text style={styles.sideTitle}>Langues</Text>
              {cv.languages.map((lang, idx) => (
                <Text style={styles.sideText} key={idx}>
                  {lang.name} : {lang.level}
                </Text>
              ))}
            </View>
          )}

          {!!cv.interests?.length && (
            <View style={styles.sideBlock}>
              <Text style={styles.sideTitle}>Centres d'intérêt</Text>
              <Text style={styles.sideText}>{cv.interests.join(' · ')}</Text>
            </View>
          )}
        </View>

        <View style={styles.right}>
          <Text style={styles.headerName}>{cv.fullName}</Text>
          {!!cv.headline && <Text style={styles.headerHeadline}>{cv.headline}</Text>}

          {!!cv.summary && <Text style={styles.summary}>{cv.summary}</Text>}

          {!!cv.education?.length && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Education</Text>
              {cv.education.map((edu, idx) => (
                <View style={styles.eduRow} key={idx}>
                  <Text style={styles.eduPeriod}>{edu.period}</Text>
                  <View>
                    <Text style={styles.eduDegree}>{edu.school}</Text>
                    <Text style={styles.eduSchool}>
                      {[edu.degree, edu.location].filter(Boolean).join(' — ')}
                    </Text>
                  </View>
                </View>
              ))}
            </View>
          )}

          {!!cv.experiences?.length && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Expérience professionnelle</Text>
              {cv.experiences.map((exp, idx) => (
                <View style={styles.entry} key={idx}>
                  <View style={styles.expHeaderRow}>
                    <View style={styles.expCompanyLine}>
                      <View style={styles.expDot} />
                      <Text style={styles.entryTitle}>
                        {[exp.company, exp.location].filter(Boolean).join(' - ')}
                      </Text>
                    </View>
                    {!!exp.period && <Text style={styles.entryPeriod}>{exp.period}</Text>}
                  </View>
                  {!!exp.role && <Text style={styles.expRole}>{exp.role}</Text>}
                  {exp.bullets?.map((bullet, bidx) => (
                    <Bullet key={bidx} text={bullet} styles={styles} />
                  ))}
                </View>
              ))}
            </View>
          )}

          {!!cv.projects?.length && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Projets perso réalisés</Text>
              {cv.projects.map((proj, idx) => (
                <View style={styles.entry} key={idx}>
                  <View style={styles.entryRow}>
                    <Text style={styles.entryTitle}>{proj.name}</Text>
                    {!!proj.period && <Text style={styles.entryPeriod}>{proj.period}</Text>}
                  </View>
                  {proj.bullets?.map((bullet, bidx) => (
                    <Bullet key={bidx} text={bullet} styles={styles} />
                  ))}
                </View>
              ))}
            </View>
          )}

          {!!cv.certifications?.length && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Certificats</Text>
              {cv.certifications.map((cert, idx) => (
                <View style={styles.certRow} key={idx}>
                  <Text style={styles.certName}>
                    {cert.name}
                    {cert.issuer ? <Text style={styles.certIssuer}> — {cert.issuer}</Text> : null}
                  </Text>
                  {!!cert.date && <Text style={styles.certDate}>{cert.date}</Text>}
                </View>
              ))}
            </View>
          )}
        </View>
      </Page>
    </Document>
  );
}
