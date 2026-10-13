import '../../styles/comparison.css';

export function CompareApprovalNotice() {
  return (
    <section className="compare-approval" aria-label="Automatic reviewer">
      <strong>Automatic reviewer · Auto</strong>
      <p>
        Two builders work independently. A reviewer compares their checked results and may request
        up to two repairs of a promising alternative. You confirm what gets published.
      </p>
    </section>
  );
}
