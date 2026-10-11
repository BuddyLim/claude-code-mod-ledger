// The pipeline drawn across, where it can be pointed at: a surface module, so
// a click on a node (or on the id beside it) picks that task, as a job is
// picked in a CI run's graph. It draws what it is handed and reports the
// click; what a pick means is the hooks module's to say.

import type { ClientModule } from 'claude-code'

// A piece of one line of the pipeline: its text and how it is drawn, and for
// a node or its id, the task it stands for.
export type StripPiece = {
  text: string
  color?: string
  isDim?: boolean
  isBold?: boolean
  isInverse?: boolean
  id?: string
  // For what is drawn after the last node: the run that comes next.
  run?: number
}

export type StripProps = { lines: StripPiece[][] }

// What a click posts to the hooks module: the task to show, or the run to open.
export type StripPick = { pick: string } | { open: number }

// The task under the pointer: '' for a line, or nothing.
type State = { over: string }

const Strip: ClientModule<StripProps, State> = (props, surface) => {
  const { Box, Text } = surface.elements
  const over = surface.state?.over ?? ''
  // What a piece is pointed at as: its task, the run it leads to, or nothing.
  const nameOf = (piece: StripPiece): string => piece.id ?? (piece.run === undefined ? '' : `run ${piece.run}`)
  // The piece at a cell of the region.
  const pieceAt = (x: number, y: number): StripPiece | undefined => {
    let column = 0

    for (const piece of props.lines[y] ?? []) {
      if (x >= column && x < column + piece.text.length) {
        return piece
      }

      column += piece.text.length
    }

    return undefined
  }

  // Set on every call, so it reads the lines as they now are.
  surface.onPointer(event => {
    const piece = event.type === 'leave' ? undefined : pieceAt(event.x, event.y)
    const name = piece === undefined ? '' : nameOf(piece)

    if (event.type === 'down' && piece?.id !== undefined) {
      surface.post({ pick: piece.id })
    } else if (event.type === 'down' && piece?.run !== undefined) {
      surface.post({ open: piece.run })
    }

    if (name !== (surface.state?.over ?? '')) {
      surface.setState({ over: name })
    }
  })

  return (
    <Box flexDirection="column">
      {props.lines.map(line => (
        <Text wrap="truncate-end">
          {line.map(piece => (
            <Text
              {...(piece.color !== undefined ? { color: piece.color } : {})}
              dimColor={piece.isDim === true && nameOf(piece) !== over}
              bold={piece.isBold === true || (over !== '' && nameOf(piece) === over)}
              inverse={piece.isInverse === true}
              underline={over !== '' && nameOf(piece) === over}
            >
              {piece.text}
            </Text>
          ))}
        </Text>
      ))}
    </Box>
  )
}

export default Strip
