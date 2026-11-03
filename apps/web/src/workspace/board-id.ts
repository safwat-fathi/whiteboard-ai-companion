// The board this browser opens by default: the remembered one, else the first, else a new "Main".
export async function getOrCreateBoard(apiBase: string): Promise<string> {
  const cached =
    typeof localStorage !== 'undefined'
      ? localStorage.getItem('whiteboard:boardId')
      : null
  const res = await fetch(`${apiBase}/api/boards`)
  if (!res.ok) throw new Error(`Failed to list boards: ${res.status}`)
  const data = (await res.json()) as { boards?: { id: string }[] }
  const boards = data.boards ?? []
  if (cached && boards.some((b) => b.id === cached)) {
    return cached
  }
  if (boards.length > 0 && boards[0]) {
    const id = boards[0].id
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('whiteboard:boardId', id)
    }
    return id
  }
  const postRes = await fetch(`${apiBase}/api/boards`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Main' }),
  })
  if (!postRes.ok) throw new Error(`Failed to create board: ${postRes.status}`)
  const postData = (await postRes.json()) as { id: string }
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem('whiteboard:boardId', postData.id)
  }
  return postData.id
}
