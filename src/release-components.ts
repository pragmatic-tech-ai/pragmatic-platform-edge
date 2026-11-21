import { ContainerComponentSource, ReleaseApp } from '@pragmatic-tech-ai/pragmatic-release-toolkit'
import { PlatformEdgeComponent } from './platform-edge-component.js'

/**
 * This repository's one component, as `pragmatic-component-descriptors --components dist/release-components.js` reads it
 * (the image's `component-set` and `component` stages).
 */
export const Components = new ContainerComponentSource(ReleaseApp.PlatformEdge, () => PlatformEdgeComponent.Descriptor())
