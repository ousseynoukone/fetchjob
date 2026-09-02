import { Document, Page, Text, View, StyleSheet } from '@react-pdf/renderer';

export interface CoverLetterData {
  fullName: string;
  email?: string;
  phone?: string;
  location?: string;
  company: string;
  jobTitle: string;
  body: string;
}

const styles = StyleSheet.create({
  page: {
    padding: '25mm 20mm',
    fontSize: 11,
    fontFamily: 'Helvetica',
    lineHeight: 1.5,
    color: '#1f2937',
  },
  header: {
    marginBottom: 24,
  },
  name: {
    fontSize: 14,
    fontFamily: 'Helvetica-Bold',
    marginBottom: 2,
  },
  contact: {
    fontSize: 9,
    color: '#6b7280',
  },
  recipient: {
    marginBottom: 20,
    fontSize: 11,
  },
  paragraph: {
    marginBottom: 12,
    textAlign: 'justify',
  },
});

export function CoverLetterDocument({ letter }: { letter: CoverLetterData }) {
  const contactLine = [letter.email, letter.phone, letter.location].filter(Boolean).join(' · ');
  const paragraphs = letter.body.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);

  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <View style={styles.header}>
          <Text style={styles.name}>{letter.fullName}</Text>
          {!!contactLine && <Text style={styles.contact}>{contactLine}</Text>}
        </View>

        <View style={styles.recipient}>
          <Text>{letter.company}</Text>
          <Text>Objet : Candidature au poste de {letter.jobTitle}</Text>
        </View>

        {paragraphs.map((p, i) => (
          <Text key={i} style={styles.paragraph}>
            {p}
          </Text>
        ))}
      </Page>
    </Document>
  );
}
