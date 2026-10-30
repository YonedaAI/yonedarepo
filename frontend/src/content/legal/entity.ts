// The facts the Terms and Privacy Policy state about the company that only the owner can
// supply. The legal pages name them as `{{field}}`; the site tests fail while any field is
// empty, so a page never ships with a gap or a placeholder in it.
export const LEGAL_ENTITY = {
  /** The company's full registered name. */
  legalName: '',
  /** Its kind, as registered: for example "limited liability company". */
  entityType: '',
  /** Where it is registered: a state or country. */
  formation: '',
  /** The postal address for legal notices, including copyright notices. */
  postalAddress: '',
  /** The law that governs the Terms: a state or country. */
  governingLaw: '',
  /** Where disputes are heard: the courts, or an arbitration body and seat. */
  disputeVenue: '',
  /** The youngest age at which a person may use the service. */
  minimumAge: '',
  /** The date both pages were last changed (YYYY-MM-DD). */
  lastUpdated: '2026-10-29',
};

export type LegalField = keyof typeof LEGAL_ENTITY;
