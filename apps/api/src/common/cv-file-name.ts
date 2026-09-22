// The CV file keeps the candidate's own name, everywhere it is produced: the
// copy uploaded to a recruiter's form, the adapted CV downloaded from a
// candidature, and the base CV downloaded from the builder. Naming it after
// the receiving company ("cv-Innovation @PSL.pdf") tells the recruiter
// nothing, and a first-name-only file ("Ousseynou - CV.pdf") is worse: it is
// the one attachment they keep.
export function buildCvFileName(fullName: string | undefined | null): string {
  const cleaned = (fullName || '')
    .replace(/[\\/:*?"<>|]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  return cleaned ? `CV ${cleaned.toUpperCase()}.pdf` : 'CV.pdf';
}
