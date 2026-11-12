/* Shared client context.

   The panels used to be closures inside createStudio(), which meant every helper
   (api, toast, kit, field components, dialogs) was in lexical scope. Once they
   move into their own modules they need those handles from somewhere: the studio
   factory provides them once, panels read them through client(). */

let current = null

export function provideClient(next) {
  current = next
}

export function client() {
  if (current === null) throw new Error('studio client context is not ready')
  return current
}
