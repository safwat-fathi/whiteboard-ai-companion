'use client'

import { useParams } from 'next/navigation'
import { Workspace } from '../../../src/workspace/Workspace'

export default function BoardPage() {
  const { id } = useParams<{ id: string }>()
  return <Workspace boardId={id} />
}
