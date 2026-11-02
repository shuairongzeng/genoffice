# La pantalla de inicio: dónde están sus archivos

Inicio es la página de arranque de GenOffice: el escritorio con sus iconos y el dock en el borde inferior, listas de archivos y tarjetas de creación rápida en el centro.

![La pantalla de inicio](img/home-screen.png)

## El dock

- **Recientes**: los archivos que abrió recientemente. Cada fila lleva su momento: hoy, ayer o la fecha.
- **Destacados**: los archivos que marcó como destacados. Pase el cursor por una fila y haga clic en la estrella para añadirlos o quitarlos. **Mover a grupo** en el menú ⋯ ordena los archivos destacados en grupos con nombre; la vista Destacados filtra por ellos.
- **Ask AI**: el panel de base de conocimiento — pregunta y recibe respuestas citadas desde tus archivos destacados (ver abajo).
- **Genspark Projects**: tras iniciar sesión en su cuenta de Genspark, muestra los proyectos que creó con Genspark AI en la web; haga clic en uno para seguir editando en el navegador. Admite búsqueda, ordenación por fecha, actualización y cargar más.
- **Carpetas**: las raíces viven en el escritorio. Haga clic derecho en el escritorio vacío para **Añadir carpeta al escritorio…**; el clic derecho sobre el icono de una raíz la quita del escritorio (la carpeta en el disco nunca se toca). Una raíz se abre como vista propia: navegar, crear subcarpetas, renombrar y mover se hace desde allí. Arrastrar archivos desde el explorador los fija como alias.

El dock del borde inferior es el lanzador al estilo macOS: los iconos se agrandan bajo el puntero, un punto marca la vista activa, arrastre para reordenar dentro de un grupo, clic derecho para el menú. Ajustes → Dock desactiva la ampliación, cambia el tamaño de los iconos u oculta el dock (pasar el cursor por el borde inferior lo devuelve). El escritorio también lleva la tarjeta de captura rápida de tareas — muévala por su asa; la posición se recuerda.
Aquí no hay ninguna entrada Papelera. Los archivos borrados van a la papelera del sistema, y restaurarlos es asunto del sistema operativo.

## La lista de archivos

Cada fila muestra un icono, el nombre del archivo, la fecha de modificación y más. El **menú ⋯** de la fila ofrece:
### Varios archivos a la vez

Marque la casilla de una fila, o haga ⌘/ctrl-clic, para ir formando una selección; la casilla de la cabecera selecciona todo lo que aparece en ese momento, y una barra sobre la lista indica (**{n} seleccionados**) cuántos están seleccionados y ofrece **Mover a carpeta…** y **Eliminar archivos** para todo el conjunto. También puede arrastrar una selección múltiple sobre una fila de carpeta de la vista de carpetas.

## Búsqueda

El cuadro de búsqueda de arriba cubre dos cosas a la vez:
## Tarjetas de inicio rápido

Las tarjetas que están encima de las listas crean un documento en un solo paso. Al hacer clic en una tarjeta se crea un archivo de ese tipo y se abre su editor: puede escribir de inmediato o dejar que la IA lo redacte (cada editor tiene un **botón de IA** en la cinta de opciones y **Pedir a la IA** en el menú contextual de la selección).

El archivo nuevo va a la vista de carpetas en la que esté; fuera de toda carpeta, va a la carpeta predeterminada.

Qué hace cada tarjeta:
> Sugerencia: Archivo ▸ Nuevo en la barra de menús crea los mismos tipos de documento (⌘N/Ctrl+N crea un documento de texto de forma predeterminada); arrastrar un archivo a la ventana lo abre.

## Pregunta a tu base de conocimiento

- Destaca primero archivos (cualquier tipo que la app lea); la cabecera del panel cuenta el corpus, y una base vacía te invita a destacar algo.
- Las respuestas citan los archivos de origen; haz clic en una cita para abrir el archivo en su editor.
- Requiere iniciar sesión en Genspark. La conversación vive solo en memoria — cerrar la app la termina.
- La búsqueda usa el índice local de archivos, como la de Inicio; los archivos desaparecidos se salen del corpus sin ruido.
- Los grupos solo organizan la lista Destacados — la base de conocimiento siempre abarca todos los archivos destacados.

## Proyectos en la nube (Genspark Projects)

- El primer uso requiere iniciar sesión en su cuenta de Genspark (flujo por código de dispositivo: GenOffice muestra un código y usted completa el inicio de sesión en el navegador).
- La lista de proyectos se sincroniza con la web; Abrir en el navegador lleva allí para continuar.
- No iniciar sesión no afecta a ninguna función local.
