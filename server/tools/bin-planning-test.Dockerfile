FROM mbbs-return-batch-browser-test:20260918
# Reuse the already-installed application dependencies (including PDFKit) and
# keep the dev/browser tooling in the test image. No dependency is downloaded.
COPY --from=mbbs-operator-app:stock-request-layout-20260927 /app/node_modules/ /app/node_modules/
