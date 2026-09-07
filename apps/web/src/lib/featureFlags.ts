/**
 * Interruptores de build para trabalho que existe mas ainda não deve aparecer.
 *
 * Flows ficou escondida por um tempo porque as arestas detectadas só cobrem
 * links parent/child de flows do BullMQ: uma fila que simplesmente chama
 * `outraFila.add()` não aparece, e isso lia como "quebrado" em vez de
 * "não observável". A página resolve isso deixando o usuário desenhar as
 * arestas que faltam à mão, e o texto da tela explica a diferença — então
 * está ligada de novo. Também é o que a tela de licença promete.
 */
export const SHOW_FLOWS = true;
