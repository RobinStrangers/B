import { redirect } from 'next/navigation';

export default function ProfilePage() {
  redirect('/trade?account=1');
}
