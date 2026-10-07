import { useMockV2, type Shot } from '@features/team/mock2/MockV2';
import { useTeamMapFocus } from '@features/team/map/teamMapFocus';
import { useTeamStore } from '@state/teamStore';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect } from 'react';

const FOCUS: Record<string, [number, number, number]> = {
  a: [-70.9205, 47.0832, 14.3],
  b: [-70.9185, 47.0812, 14.8],
  d: [-70.9232, 47.0826, 14.8],
  e: [-70.9203, 47.0828, 15.4],
  f: [-70.9185, 47.0812, 14.8],
};

export default function Mock2Route() {
  const { shot } = useLocalSearchParams<{ shot?: string }>();
  const router = useRouter();
  useEffect(() => {
    const s = shot && 'abcdefghijklmno'.includes(shot) ? (shot as Shot) : null;
    useMockV2.getState().set(s);
    router.replace('/');
  }, [shot, router]);
  return null;
}
