import ApplicationDetail from '@/components/applications/application-detail';

export default function Page({ params }: { params: { id: string } }) {
  return <ApplicationDetail id={params.id} />;
}
