import { useState } from 'react';
import Container from '@cloudscape-design/components/container';
import CsHeader from '@cloudscape-design/components/header';
import Pagination from '@cloudscape-design/components/pagination';
import { ReportList, Report, SectionTitle } from './ReportList';

interface CategoryIndexProps {
  categoryName: string;
  reports: Report[];
  icon?: string;
}

const ITEMS_PER_PAGE = 5;

export function CategoryIndex({ categoryName, reports, icon }: CategoryIndexProps): JSX.Element {
  const sortedReports = [...reports].reverse();
  const [page, setPage] = useState(1);
  const totalPages = Math.ceil(sortedReports.length / ITEMS_PER_PAGE);
  const pageReports = sortedReports.slice((page - 1) * ITEMS_PER_PAGE, page * ITEMS_PER_PAGE);

  return (
    <div style={{ maxWidth: '1200px', margin: '32px auto', padding: '0 24px' }}>
      <Container
        header={<CsHeader variant="h2"><SectionTitle icon={icon}>{categoryName}</SectionTitle></CsHeader>}
        footer={totalPages > 1 && (
          <Pagination
            currentPageIndex={page}
            pagesCount={totalPages}
            onChange={({ detail }) => setPage(detail.currentPageIndex)}
            ariaLabels={{ nextPageLabel: 'Next page', previousPageLabel: 'Previous page', pageLabel: n => `Page ${n}` }}
          />
        )}
      >
        <ReportList reports={pageReports} ariaLabel={categoryName} emptyText="No reports yet" />
      </Container>
    </div>
  );
}
