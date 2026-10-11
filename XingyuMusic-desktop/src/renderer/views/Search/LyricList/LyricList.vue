<template>
  <div :class="$style.container">
    <div v-show="!listInfo.noItemLabel" ref="dom_list_ref" :class="$style.listContent" class="scroll">
      <ul>
        <li v-for="item in listInfo.list" :key="item.source + item.id" :class="$style.item" @click="playLyricSong(item)">
          <div :class="$style.image">
            <img v-if="item.img" :class="$style.img" loading="lazy" decoding="async" :src="item.img" @error="$event.target.remove()">
            <img v-else :class="$style.img" src="@renderer/assets/images/xingyu-logo.png" alt="" />
          </div>
          <div :class="$style.desc">
            <h4>{{ item.name }}</h4>
            <p v-if="item.singer" :class="$style.singer">{{ item.singer }}</p>
            <p v-if="item.lyric" :class="$style.lyricSnippet" v-text="item.lyric" />
            <span v-if="visibleSource" :class="$style.source">{{ sourceLabel(item.source) }}</span>
          </div>
        </li>
      </ul>
      <div v-if="listInfo.list.length" :class="$style.pagination">
        <material-pagination :count="listInfo.total" :limit="listInfo.limit" :page="listInfo.page" @btn-click="togglePage" />
      </div>
    </div>
    <transition enter-active-class="animated fadeIn" leave-active-class="animated fadeOut">
      <div v-show="listInfo.noItemLabel" :class="$style.noitem">
        <p v-text="listInfo.noItemLabel" />
      </div>
    </transition>
  </div>
</template>

<script setup>
import { ref } from '@common/utils/vueTools'
import { LIST_IDS } from '@common/constants'
import { sourceNames, qualityList } from '@renderer/store'
import { playList } from '@renderer/core/player/action'
import { addListMusics, setTempList } from '@renderer/store/list/action'
import { assertApiSupport } from '@renderer/store/utils'

defineProps({
  listInfo: {
    type: Object,
    required: true,
  },
  visibleSource: {
    type: Boolean,
    default: false,
  },
})

const dom_list_ref = ref(null)

const emit = defineEmits(['toggle-page'])

const togglePage = (page) => {
  emit('toggle-page', page)
}

const sourceLabel = (source) => sourceNames.value[source] || source

// 歌词检索结果对应的是「带歌词的歌」，点击直接在播放器播放
const playLyricSong = (item) => {
  if (!assertApiSupport(item.source)) return
  const qualities = qualityList.value[item.source] || ['128k']
  const song = {
    source: item.source,
    id: item.id,
    name: item.name,
    artist: item.singer || '',
    album: '',
    img: item.img || null,
    duration: null,
    type: [qualities[0]],
    typeUrl: {},
  }
  void addListMusics(LIST_IDS.DEFAULT, [song])
  void setTempList('search_play', [song]).then(() => {
    playList(LIST_IDS.TEMP, 0)
  })
}

defineExpose({
  scrollTo(top) {
    dom_list_ref.value?.scrollTo({
      top,
    })
  },
  getScrollTop() {
    return dom_list_ref.value?.scrollTop ?? 0
  },
})
</script>

<style lang="less" module>
@import '@renderer/assets/styles/layout.less';
.container {
  overflow: hidden;
  height: 100%;
  display: flex;
  flex-flow: column nowrap;
  position: relative;
}

.listContent {
  position: absolute;
  left: 0;
  top: 0;
  width: 100%;
  height: 100%;
  display: flex;
  flex-flow: column nowrap;
  font-size: 14px;
  box-sizing: border-box;
  padding: 15px 15px 0;

  ul {
    display: flex;
    flex-flow: row wrap;
    justify-content: space-between;
  }
}
.item {
  max-width: 360px;
  width: 32%;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  margin-bottom: 20px;
  position: relative;
  cursor: pointer;
  transition: opacity @transition-normal;
  &:hover {
    opacity: .8;
  }
}
.image {
  flex: none;
  width: 100%;
  display: flex;
  background-position: center;
  background-size: cover;
  border-radius: 4px;
  overflow: hidden;
  opacity: .9;
  aspect-ratio: 16 / 9;

  box-shadow: 0 0 2px 0 rgba(0,0,0,.2);
}
.img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.desc {
  flex: auto;
  padding: 6px 2px 0;
  overflow: hidden;
  h4 {
    font-size: 14px;
    line-height: 1.3;
    .mixin-ellipsis-1();
  }
}
.singer {
  margin-top: 4px;
  font-size: 12px;
  .mixin-ellipsis-1();
  color: var(--color-font-label);
}
.lyricSnippet {
  margin-top: 4px;
  font-size: 12px;
  line-height: 1.4;
  .mixin-ellipsis-2();
  color: var(--color-font-label);
  white-space: normal;
}
.source {
  margin-top: 4px;
  display: inline-block;
  padding: 0 6px;
  font-size: 11px;
  border-radius: 8px;
  background-color: var(--color-primary);
  color: var(--color-primary-font);
}
.pagination {
  text-align: center;
  padding: 15px 0;
}
.noitem {
  position: absolute;
  top: 0;
  left: 0;
  height: 100%;
  width: 100%;
  display: flex;
  flex-flow: column nowrap;
  justify-content: center;
  align-items: center;

  p {
    font-size: 24px;
    color: var(--color-font-label);
  }
}
</style>
