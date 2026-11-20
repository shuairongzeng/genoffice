import { AI_PET_IDS, type AiPetId } from '../../shared/ai-pet-prefs'
import type { StringKey } from './locale'

/**
 * Presentation and localization metadata for one AI companion species.
 */
export interface AiPetCatalogMeta {
  readonly id: AiPetId
  readonly nameKey: StringKey
  readonly tagKey: StringKey
  readonly descKey: StringKey
  readonly helloKey: StringKey
  readonly lineKeys: {
    readonly pet: StringKey
    readonly feed: StringKey
    readonly play: StringKey
  }
}

const PET_META_BY_ID: Readonly<Record<AiPetId, AiPetCatalogMeta>> = {
  bluebird: {
    id: 'bluebird',
    nameKey: 'petNameBluebird',
    tagKey: 'petTagBluebird',
    descKey: 'petDescBluebird',
    helloKey: 'petHelloBluebird',
    lineKeys: {
      pet: 'petLineBluebirdPet',
      feed: 'petLineBluebirdFeed',
      play: 'petLineBluebirdPlay',
    },
  },
  cat: {
    id: 'cat',
    nameKey: 'petNameCat',
    tagKey: 'petTagCat',
    descKey: 'petDescCat',
    helloKey: 'petHelloCat',
    lineKeys: {
      pet: 'petLineCatPet',
      feed: 'petLineCatFeed',
      play: 'petLineCatPlay',
    },
  },
  robot: {
    id: 'robot',
    nameKey: 'petNameRobot',
    tagKey: 'petTagRobot',
    descKey: 'petDescRobot',
    helloKey: 'petHelloRobot',
    lineKeys: {
      pet: 'petLineRobotPet',
      feed: 'petLineRobotFeed',
      play: 'petLineRobotPlay',
    },
  },
  fox: {
    id: 'fox',
    nameKey: 'petNameFox',
    tagKey: 'petTagFox',
    descKey: 'petDescFox',
    helloKey: 'petHelloFox',
    lineKeys: {
      pet: 'petLineFoxPet',
      feed: 'petLineFoxFeed',
      play: 'petLineFoxPlay',
    },
  },
  panda: {
    id: 'panda',
    nameKey: 'petNamePanda',
    tagKey: 'petTagPanda',
    descKey: 'petDescPanda',
    helloKey: 'petHelloPanda',
    lineKeys: {
      pet: 'petLinePandaPet',
      feed: 'petLinePandaFeed',
      play: 'petLinePandaPlay',
    },
  },
}

/** Ordered catalog of all available AI companion species. */
export const AI_PET_CATALOG: readonly AiPetCatalogMeta[] = AI_PET_IDS.map(
  (id) => PET_META_BY_ID[id],
)

/** Look up catalog metadata for a pet species, falling back to bluebird. */
export function petMetaFor(id: AiPetId): AiPetCatalogMeta {
  return PET_META_BY_ID[id] ?? PET_META_BY_ID.bluebird
}
